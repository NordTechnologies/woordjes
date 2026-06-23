#!/bin/sh
# Xcode Cloud post-clone: install Flutter and generate the files that xcodebuild needs
# (ios/Flutter/ephemeral/..., Generated.xcconfig, Pods). These are git-ignored, so the
# cloud machine must create them before the archive build.
set -e

echo "▸ Installing Flutter (stable)…"
git clone https://github.com/flutter/flutter.git --depth 1 -b stable "$HOME/flutter"
export PATH="$HOME/flutter/bin:$PATH"
flutter --version

echo "▸ Generating Flutter build files…"
cd "$CI_PRIMARY_REPOSITORY_PATH/app"
flutter precache --ios
flutter pub get
# Regenerates Generated.xcconfig (with this machine's FLUTTER_ROOT) and the
# ephemeral Swift Package the archive references. --config-only = no compile.
flutter build ios --config-only --no-codesign

echo "▸ Installing CocoaPods dependencies…"
cd ios
pod install

echo "▸ Post-clone complete."
