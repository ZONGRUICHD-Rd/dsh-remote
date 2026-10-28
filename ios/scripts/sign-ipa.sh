#!/usr/bin/env bash
# Optional signed build. Configure repository secrets:
#   IOS_CERT_P12_BASE64, IOS_CERT_PASSWORD, IOS_PROVISION_PROFILE_BASE64, IOS_TEAM_ID
#   IOS_EXPORT_METHOD (ad-hoc | development | app-store-connect; default ad-hoc)
set -euo pipefail
VERSION=$(node -p "require('../bridge/package.json').version")
KEYCHAIN="$RUNNER_TEMP/signing.keychain-db"
KEYCHAIN_PASSWORD=$(uuidgen)
echo "$IOS_CERT_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/cert.p12"
echo "$IOS_PROVISION_PROFILE_BASE64" | base64 --decode > "$RUNNER_TEMP/profile.mobileprovision"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$RUNNER_TEMP/cert.p12" -P "$IOS_CERT_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN"
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
PROFILE_PLIST="$RUNNER_TEMP/profile.plist"
security cms -D -i "$RUNNER_TEMP/profile.mobileprovision" > "$PROFILE_PLIST"
UUID=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$PROFILE_PLIST")
PROFILE_NAME=$(/usr/libexec/PlistBuddy -c 'Print Name' "$PROFILE_PLIST")
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print Entitlements:application-identifier' "$PROFILE_PLIST" | cut -d. -f2-)
mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
cp "$RUNNER_TEMP/profile.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/$UUID.mobileprovision"

xcodebuild -project DSHRemote.xcodeproj -scheme DSHRemote -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/DSHRemote.xcarchive \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN" archive > archive.log 2>&1 || { grep -E "error:" archive.log | head -50; exit 1; }

cat > "$RUNNER_TEMP/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>${IOS_EXPORT_METHOD:-ad-hoc}</string>
  <key>teamID</key><string>$IOS_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE_ID</key><string>$PROFILE_NAME</string></dict>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath build/DSHRemote.xcarchive -exportOptionsPlist "$RUNNER_TEMP/export.plist" -exportPath build/export
cp build/export/*.ipa "dist/DSHRemote-$VERSION.ipa"
security delete-keychain "$KEYCHAIN" || true
