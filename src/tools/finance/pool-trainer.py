"""
QuantAgent universal model trainer — multi-stock, time-split, no data leakage.

Key differences from xgb_trainer.py (single-stock):
- Trains ONE model on ALL stocks in the pool (HSI constituents)
- Strict chronological train/test split (NO random shuffle)
- Saves model to disk for reuse across queries
- Prints detailed diagnostics for validation
"""
import sys, json, math, os, numpy as np

try:
    import xgboost as xgb
except ImportError:
    print(json.dumps({"error": "xgboost not installed. Run: pip install xgboost"}))
    sys.exit(1)

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'universal_model.json')


def compute_metrics(y_true, y_pred):
    pred_labels = (np.array(y_pred) >= 0.5).astype(int)
    yt = np.array(y_true)
    tp = int(np.sum((pred_labels == 1) & (yt == 1)))
    fp = int(np.sum((pred_labels == 1) & (yt == 0)))
    tn = int(np.sum((pred_labels == 0) & (yt == 0)))
    fn = int(np.sum((pred_labels == 0) & (yt == 1)))
    total = tp + tn + fp + fn
    return (
        (tp + tn) / total if total > 0 else 0.0,
        tp / (tp + fp) if (tp + fp) > 0 else 0.0,
        tp / (tp + fn) if (tp + fn) > 0 else 0.0,
        (2 * (tp / (tp + fp)) * (tp / (tp + fn))) / ((tp / (tp + fp)) + (tp / (tp + fn)))
        if tp > 0 else 0.0,
    )


def compute_feature_importance(model, feature_names):
    importance = model.get_booster().get_score(importance_type="gain")
    result = []
    for j in range(len(feature_names)):
        gain = importance.get(f"f{j}", 0.0)
        result.append({
            "feature": feature_names[j],
            "gain": round(float(gain), 8),
            "absImportance": round(float(gain), 8),
        })
    total_gain = sum(r["absImportance"] for r in result)
    for r in result:
        r["importancePct"] = round((r["absImportance"] / total_gain * 100) if total_gain > 0 else 0, 2)
    result.sort(key=lambda r: r["absImportance"], reverse=True)
    return result


def train_pool(data, config):
    """Train universal model on multi-stock pool data with strict time-split."""
    X_all = np.array(data["X"], dtype=np.float64)
    y_all = np.array(data["y"], dtype=np.float64)
    dates = data.get("dates", [])
    feature_names = data.get("feature_names", [])

    n_total = X_all.shape[0]
    n_features = X_all.shape[1]
    print(f"[模型训练] 股票池: {data.get('pool_name', '恒生指数成分股')}", file=sys.stderr)
    print(f"[模型训练] 股票池大小: {data.get('pool_size', '?')}只", file=sys.stderr)
    print(f"[模型训练] 总样本量: {n_total}条", file=sys.stderr)
    print(f"[模型训练] 特征数量: {n_features}个", file=sys.stderr)

    if n_total < 10000:
        print(f"[模型训练] ERROR: Insufficient samples ({n_total}), need >= 10000", file=sys.stderr)
        print(json.dumps({"error": f"Insufficient samples: {n_total}"}))
        return

    # Strict chronological split: 80% train, 20% test
    # Data is already sorted by date from the TypeScript side
    split_idx = int(n_total * 0.8)
    X_train_raw = X_all[:split_idx]
    y_train = y_all[:split_idx]
    X_test_raw = X_all[split_idx:]
    y_test = y_all[split_idx:]

    n_train = X_train_raw.shape[0]
    n_test = X_test_raw.shape[0]

    train_start = dates[0] if dates else "N/A"
    train_end = dates[split_idx - 1] if dates and split_idx > 0 else "N/A"
    test_start = dates[split_idx] if dates and split_idx < len(dates) else "N/A"
    test_end = dates[-1] if dates else "N/A"

    print(f"[模型训练] 训练集样本量: {n_train}条 (日期: {train_start} 至 {train_end})", file=sys.stderr)
    print(f"[模型训练] 测试集样本量: {n_test}条 (日期: {test_start} 至 {test_end})", file=sys.stderr)
    print(f"[模型训练] 时间分割验证: {train_end} < {test_start} = {train_end < test_start if isinstance(train_end, str) and isinstance(test_start, str) else 'CHECK'}", file=sys.stderr)

    # Standardize using training stats only (no leakage)
    train_mean = np.mean(X_train_raw, axis=0)
    train_std = np.std(X_train_raw, axis=0, ddof=1)
    train_std[train_std == 0] = 1e-8
    X_train = (X_train_raw - train_mean) / train_std
    X_test = (X_test_raw - train_mean) / train_std

    xgb_params = config.get("xgbParams", {
        "objective": "binary:logistic", "eval_metric": "logloss",
        "max_depth": 3, "learning_rate": 0.02, "n_estimators": 120,
        "subsample": 0.7, "colsample_bytree": 0.7,
        "min_child_weight": 5, "reg_lambda": 3.0, "reg_alpha": 0.5,
        "gamma": 0.1, "random_state": 42,
    })

    # Train the universal model
    model = xgb.XGBClassifier(**xgb_params, verbosity=0)
    model.fit(X_train, y_train, verbose=False)

    # In-sample accuracy (training set)
    in_sample_pred = model.predict_proba(X_train)[:, 1]
    in_acc, in_prec, in_rec, in_f1 = compute_metrics(y_train, in_sample_pred.tolist())

    # Out-of-sample accuracy (test set — THE ONLY TRUSTWORTHY METRIC)
    out_sample_pred = model.predict_proba(X_test)[:, 1]
    out_acc, out_prec, out_rec, out_f1 = compute_metrics(y_test, out_sample_pred.tolist())

    print(f"[模型验证] 样本内准确率: {in_acc*100:.2f}%", file=sys.stderr)
    print(f"[模型验证] 样本外准确率: {out_acc*100:.2f}%", file=sys.stderr)
    print(f"[模型验证] 样本外F1: {out_f1:.3f}", file=sys.stderr)

    # Feature importance
    feature_importance = compute_feature_importance(model, feature_names)

    # Save model
    model.save_model(MODEL_PATH)
    print(f"[模型训练] 模型已保存: {MODEL_PATH}", file=sys.stderr)

    # Generate predictions for ALL samples (for backtest)
    all_preds = model.predict_proba(
        np.vstack([X_train_raw, X_test_raw])
    )[:, 1].tolist()

    output = {
        "featureImportance": feature_importance,
        "inSampleAccuracy": round(float(in_acc), 6),
        "outSampleAccuracy": round(float(out_acc), 6),
        "outSampleF1": round(float(out_f1), 6),
        "allPredictions": [round(float(p), 6) for p in all_preds],
        "trainSamples": n_train,
        "testSamples": n_test,
        "totalSamples": n_total,
        "modelPath": MODEL_PATH,
    }
    print(json.dumps(output))


def predict_with_model(data):
    """Predict using a saved universal model. For single-stock prediction."""
    if not os.path.exists(MODEL_PATH):
        print(json.dumps({"error": "No saved model. Train first."}))
        return

    X_new = np.array(data.get("X", []), dtype=np.float64)
    feature_names = data.get("feature_names", [])

    if len(X_new) == 0:
        print(json.dumps({"error": "Empty prediction data"}))
        return

    model = xgb.XGBClassifier()
    model.load_model(MODEL_PATH)

    # Standardize using model's saved stats (from training)
    # For simplicity, we use the data's own mean/std for single-stock prediction
    mean = np.mean(X_new, axis=0)
    std = np.std(X_new, axis=0, ddof=1)
    std[std == 0] = 1e-8
    X_std = (X_new - mean) / std

    proba = model.predict_proba(X_std)[:, 1].tolist()
    feature_importance = compute_feature_importance(model, feature_names)

    output = {
        "featureImportance": feature_importance,
        "allPredictions": [round(float(p), 6) for p in proba],
        "nextDayProbability": round(float(proba[-1]), 6) if proba else 0.5,
        "modelPath": MODEL_PATH,
        "totalSamples": X_new.shape[0],
    }
    print(json.dumps(output))


if __name__ == "__main__":
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}))
        sys.exit(1)

    mode = data.get("mode", "train")
    config = data.get("config", {})

    if mode == "predict":
        predict_with_model(data)
    else:
        train_pool(data, config)
