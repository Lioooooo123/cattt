#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
swiftc ios/Maomao/Model/FollowupNotificationPlan.swift ios/IdentityTests/FollowupNotificationPlanTests.swift -o "$work_dir/followup-notifications"
"$work_dir/followup-notifications"
