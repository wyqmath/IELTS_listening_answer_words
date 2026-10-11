/* Resolve installed Playwright, or a runtime module supplied by the operator. */
'use strict';
try {
  module.exports = require(process.env.AUDIT_PLAYWRIGHT || 'playwright');
} catch {
  throw new Error('Playwright is required for browser audits. Run npm install, or set AUDIT_PLAYWRIGHT to an installed module.');
}

// Select installed browsers by Playwright channel, without machine-specific paths.
module.exports.auditLaunch = (channel = process.env.AUDIT_BROWSER || 'chrome') => {
  if (!['chrome', 'msedge', 'chromium'].includes(channel)) throw new Error('AUDIT_BROWSER must be chrome, msedge or chromium.');
  return { ...(channel === 'chromium' ? {} : { channel }), headless: true };
};
module.exports.auditOutput = () => {
  const path = require('node:path'), os = require('node:os');
  return process.env.AUDIT_OUTPUT_DIR ? path.resolve(process.env.AUDIT_OUTPUT_DIR) : path.join(os.tmpdir(), 'tingjian-audit');
};
