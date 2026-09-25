// Playwright from node_modules (npm install), or from a global install
let pw;
try { pw = require('playwright'); } catch (e) {
  try { pw = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); }
  catch (e2) { throw new Error('Playwright not found: run npm install (and npx playwright install chromium)'); }
}
module.exports = pw;
