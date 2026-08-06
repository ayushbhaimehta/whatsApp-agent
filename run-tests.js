const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDirectory = path.join(__dirname, 'test');
const testFiles = fs.readdirSync(testDirectory)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(testDirectory, name));

if (testFiles.length === 0) {
    console.error(`No test files found in ${testDirectory}`);
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    stdio: 'inherit'
});

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);
