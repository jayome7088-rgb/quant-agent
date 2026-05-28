#!/usr/bin/env bun
import { config } from 'dotenv';
config({ quiet: true });

import React from 'react';
import { render } from 'ink';
import { App } from './ui/app.js';

const { unmount } = render(
  React.createElement(App),
  { exitOnCtrlC: true },
);

process.on('exit', () => {
  unmount();
});
