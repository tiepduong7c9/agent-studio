// Ad-hoc sign the macOS app. With "identity": null electron-builder skips
// signing, but packaging still edits the Electron bundle, which leaves its
// original signature invalid. Apple Silicon then rejects a downloaded copy as
// "damaged". An ad-hoc signature makes it a plain unidentified-developer app
// that users can allow under Privacy & Security.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
