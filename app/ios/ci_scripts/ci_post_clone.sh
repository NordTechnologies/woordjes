#!/bin/sh
# Xcode Cloud post-clone: install Flutter and generate the files xcodebuild needs
# (ios/Flutter/ephemeral/..., Generated.xcconfig, the Swift Package the project
# references, Pods). These are git-ignored, so the cloud machine must create them
# before the archive build.
#
# Flutter is PINNED to the revision in app/.metadata (the version this project was
# built with). Cloning plain "stable" pulls whatever stable is newest that day, so
# a Flutter release can silently break a previously-working build — which is exactly
# what produced "FlutterGeneratedPluginSwiftPackage doesn't exist" + post-clone
# exit code 6. Keep FLUTTER_REV in sync with app/.metadata.
set -e

FLUTTER_REV="c9a6c484230f8b5e408ec57be1ef71dee1e77020"

echo "▸ Installing Flutter (pinned ${FLUTTER_REV})…"
# Blobless partial clone keeps full history (so an exact revision can be checked
# out) while downloading file contents only as needed — fast and reliable.
git clone --filter=blob:none https://github.com/flutter/flutter.git "$HOME/flutter"
git -C "$HOME/flutter" checkout "$FLUTTER_REV"
export PATH="$HOME/flutter/bin:$PATH"
flutter --version

echo "▸ Generating Flutter build files…"
cd "$CI_PRIMARY_REPOSITORY_PATH/app"
flutter precache --ios
flutter pub get
# Regenerates Generated.xcconfig (with this machine's FLUTTER_ROOT) and the
# ephemeral Swift Package the archive references.
flutter build ios --config-only --no-codesign

# Surface whether the Swift Package was actually generated (helps diagnose CI).
ls -d ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage \
  || echo "⚠︎ FlutterGeneratedPluginSwiftPackage was not generated"

echo "▸ Installing CocoaPods dependencies…"
cd ios
pod install

echo "▸ Post-clone complete."
