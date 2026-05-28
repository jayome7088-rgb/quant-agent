#!/usr/bin/env bun
import { config } from 'dotenv';
config({ quiet: true });

import React from 'react';
import { render } from 'ink';
import { App } from './ui/app.js';

if (!process.env.DEEPSEEK_API_KEY?.startsWith('sk-')) {
  console.error('DEEPSEEK_API_KEY is not set or invalid.');
  process.exit(1);
}

console.log('Starting Dexter Pro CLI UI...');
console.log('Type a query and press Enter. Press Ctrl+C to exit.\n');

const { unmount } = render(React.createElement(App), {
  exitOnCtrlC: true,
});

process.on('exit', () => unmount());
