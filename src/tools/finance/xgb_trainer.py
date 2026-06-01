"""
XGBoost stock direction predictor with rolling walk-forward validation.

Reads JSON from stdin, outputs JSON to stdout.
All errors printed to stderr.
"""

import sys
import json
import math
import numpy as np

try:
    import xgboost as xgb
except ImportError:
    print(json.dumps({"error": "xgboost not installed. Run: pip install xgboost"}))
    sys.exit(1)


def sigmoid(z):
    return 1.0 / (1.0 + math.exp(-max(min(z, 20.0), -20.0)))


def compute_metrics(y_true, y_pred):
    """Binary classification metrics."""
    pred_labels = (np.array(y_pred) >= 0.5).astype(int)
    yt = np.array(y_true)

    tp = int(np.sum((pred_labels == 1) & (yt == 1)))
    fp = int(np.sum((pred_labels == 1) & (yt == 0)))
    tn = int(np.sum((pred_labels == 0) & (yt == 0)))
    fn = int(np.sum((pred_labels == 0) & (yt == 1)))

    total = tp + tn + fp + fn
    accuracy = (tp + tn) / total if total > 0 else 0.0
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

    return accuracy, precision, recall, f1


def get_stats(X):
    """Compute mean and std for standardization."""
    mean = np.mean(X, axis=0)
    std = np.std(X, axis=0, ddof=1)
    std[std == 0] = 1e-8
    return mean, std


def standardize(X_train, X_test=None):
    """Standardize features: (x - mean) / std, using training set stats."""
    mean, std = get_stats(X_train)
    X_tr = (X_train - mean) / std
    if X_test is not None:
        X_te = (X_test - mean) / std
        return X_tr, X_te
    return X_tr


def compute_feature_importance(model, feature_names, X, stds):
    """Extract feature importance from XGBoost model using gain (average information gain per split).

    Gain is the correct metric for tree models — it measures how much each feature
    contributes to reducing loss across all splits. Unlike linear models, tree models
    don't have coefficients, so abs(coefficient) normalization is meaningless.

    IMPORTANT: We do NOT multiply by feature stddev. Gain already accounts for feature
    scale since splits are evaluated on raw feature values. Multiplying by stddev
    would inflate features with larger numeric ranges and zero out the rest.
    """
    importance = model.get_booster().get_score(importance_type="gain")
    n = len(feature_names)
    result = []
    for j in range(n):
        gain = importance.get(f"f{j}", 0.0)
        result.append({
            "feature": feature_names[j],
            "gain": round(float(gain), 8),
            "absImportance": round(float(gain), 8),  # raw gain = correct tree importance
        })
    total_gain = sum(r["absImportance"] for r in result)
    for r in result:
        r["importancePct"] = round((r["absImportance"] / total_gain * 100) if total_gain > 0 else 0, 2)
    result.sort(key=lambda r: r["absImportance"], reverse=True)
    return result


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}))
        sys.exit(1)

    X = data.get("X", [])
    y = data.get("y", [])
    feature_names = data.get("feature_names", [])
    config = data.get("config", {})

    if len(X) == 0 or len(y) == 0:
        print(json.dumps({"error": "Empty training data"}))
        sys.exit(1)

    X = np.array(X, dtype=np.float64)
    y = np.array(y, dtype=np.float64)

    window_size = config.get("windowSize", 500)
    test_size = config.get("testSize", 50)
    step_size = config.get("stepSize", 25)

    xgb_params = config.get("xgbParams", {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "max_depth": 4,
        "learning_rate": 0.03,
        "n_estimators": 150,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_lambda": 1.0,
        "reg_alpha": 0.1,
        "random_state": 42,
    })

    n_samples = X.shape[0]
    if n_samples < window_size + test_size:
        print(json.dumps({
            "error": f"Insufficient samples: {n_samples} (need at least {window_size + test_size})"
        }))
        sys.exit(1)

    rolling_results = []
    all_predictions = []
    final_model = None
    train_start = 0
    win_idx = 0
    max_windows = 10

    while train_start + window_size + test_size <= n_samples and win_idx < max_windows:
        train_end = train_start + window_size
        test_start = train_end
        test_end = min(test_start + test_size, n_samples)

        X_train_raw = X[train_start:train_end]
        y_train = y[train_start:train_end]
        X_test_raw = X[test_start:test_end]
        y_test = y[test_start:test_end]

        X_train, X_test = standardize(X_train_raw, X_test_raw)

        model = xgb.XGBClassifier(**xgb_params, verbosity=0)
        model.fit(X_train, y_train, verbose=False)

        proba = model.predict_proba(X_test)[:, 1].tolist()
        predictions = [float(p) for p in proba]

        accuracy, precision, recall, f1 = compute_metrics(y_test.tolist(), predictions)

        rolling_results.append({
            "windowIndex": win_idx,
            "trainStart": int(train_start),
            "trainEnd": int(train_end),
            "testStart": int(test_start),
            "testEnd": int(test_end),
            "accuracy": round(accuracy, 6),
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
            "predictions": [round(p, 6) for p in predictions],
            "actuals": [float(a) for a in y_test],
        })

        all_predictions.extend(predictions)
        final_model = model
        train_start += step_size
        win_idx += 1

    # Aggregate metrics
    n_windows = len(rolling_results)
    agg = {
        "avgAccuracy": round(sum(r["accuracy"] for r in rolling_results) / n_windows, 4) if n_windows > 0 else 0,
        "avgPrecision": round(sum(r["precision"] for r in rolling_results) / n_windows, 4) if n_windows > 0 else 0,
        "avgRecall": round(sum(r["recall"] for r in rolling_results) / n_windows, 4) if n_windows > 0 else 0,
        "avgF1": round(sum(r["f1"] for r in rolling_results) / n_windows, 4) if n_windows > 0 else 0,
    }

    # Feature importance from final model
    if final_model is not None:
        _, stds = get_stats(X[:n_samples])
        feature_importance = compute_feature_importance(final_model, feature_names, X[:n_samples], stds)
    else:
        feature_importance = []

    # Next-day probability using the most recent data point
    last_row = X[-1:]
    if final_model is not None and len(last_row) > 0:
        all_mean, all_std = get_stats(X)
        last_std = (last_row - all_mean) / all_std
        proba = final_model.predict_proba(last_std)[:, 1]
        next_day_prob = round(float(proba[0]), 6)
    else:
        next_day_prob = 0.5

    output = {
        "coefficients": [],
        "featureImportance": feature_importance,
        "rollingResults": rolling_results,
        "aggregateMetrics": agg,
        "allPredictions": [round(float(p), 6) for p in all_predictions],
        "nextDayProbability": next_day_prob,
    }

    print(json.dumps(output))


if __name__ == "__main__":
    main()
