// Sign the macOS app. With "identity": null electron-builder skips signing, but
// packaging still edits the Electron bundle, which leaves its original signature
// invalid. Apple Silicon then rejects a downloaded copy as "damaged".
//
// Release builds sign with our self-signed certificate (imported into a CI
// keychain by the release workflow, which sets MAC_SIGN_IDENTITY). macOS keys
// privacy grants (Files & Folders, Local Network, …) to the signature's
// designated requirement; with a stable certificate that requirement is the
// same for every release, so grants survive updates. An ad-hoc signature is
// just a hash of one build, so each release would be asked for them again.
// Without MAC_SIGN_IDENTITY (local builds) we fall back to ad-hoc.
//
// Either way the app isn't notarized, so Gatekeeper still blocks the first
// launch of a downloaded copy until the user allows it.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const identity = process.env.MAC_SIGN_IDENTITY || '-'
  const keychain = process.env.MAC_SIGN_KEYCHAIN
  const args = ['--force', '--deep', '--sign', identity]
  if (identity !== '-' && keychain) args.push('--keychain', keychain)
  console.log(`  • signing macOS app with ${identity === '-' ? 'an ad-hoc signature' : `"${identity}"`}`)
  execFileSync('codesign', [...args, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  // Log the designated requirement: with a certificate it names the cert, not
  // a per-build hash — that's what keeps privacy grants across updates.
  execFileSync('codesign', ['--display', '--requirements', '-', app], { stdio: 'inherit' })
}
