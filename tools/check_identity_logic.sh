#!/bin/sh
set -eu
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
swiftc ios/Maomao/Model/AccountSession.swift ios/Maomao/Model/PairedHost.swift ios/IdentityTests/IdentityLogicTests.swift -o "$work_dir/IdentityLogicTests"
"$work_dir/IdentityLogicTests"
