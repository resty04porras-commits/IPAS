#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = process.cwd();
const mobileDir = path.resolve(rootDir, 'mobile');
const mobilePackageJson = path.join(mobileDir, 'package.json');
const expoCliPath = path.join(mobileDir, 'node_modules', 'expo', 'bin', 'cli');

if (!fs.existsSync(mobilePackageJson)) {
  console.error('Expo mobile project was not found at ./mobile.');
  console.error('Run commands from the repository root or recreate the mobile wrapper.');
  process.exit(1);
}

if (!fs.existsSync(expoCliPath)) {
  console.error('Expo CLI was not found in ./mobile/node_modules.');
  console.error('Run `npm run mobile:install` from the repository root first.');
  process.exit(1);
}

const child = spawn(process.execPath, [expoCliPath, ...process.argv.slice(2)], {
  cwd: mobileDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    EXPO_USE_LOCAL_CLI: '1',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to start Expo CLI:', error.message);
  process.exit(1);
});
