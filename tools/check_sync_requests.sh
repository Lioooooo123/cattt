#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
swiftc ios/Maomao/Model/AccountSession.swift ios/Maomao/Backend/SessionVault.swift \
    ios/Maomao/Model/PairedHost.swift ios/Maomao/Backend/PairVault.swift ios/Maomao/Backend/PairTransport.swift \
    ios/Maomao/Backend/Backend.swift ios/Maomao/Model/FollowupNotificationPlan.swift ios/Maomao/Backend/AgreementAPI.swift \
    ios/Maomao/Backend/DiaryAPI.swift ios/Maomao/Model/DiaryEntry.swift ios/Maomao/Model/DiaryStorage.swift \
    ios/BackendTests/SyncRequestTests.swift -o "$work_dir/sync-requests"
"$work_dir/sync-requests"
