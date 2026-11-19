#!/usr/bin/env python3
"""Regenerate Maomao.xcodeproj/project.pbxproj from the files on disk.

Xcode can edit the project normally once it exists; this script is here so the
file list can be rebuilt from scratch after adding or moving sources, without
hand-editing pbxproj UUIDs. Run it from the `ios/` directory:

    python3 generate_project.py

Object IDs are md5-derived from a stable key, so re-running produces a
byte-identical file and diffs stay readable.
"""

import hashlib
import os
import plistlib
import re

PROJECT = "Maomao"
ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCE_DIR = PROJECT  # ios/Maomao
BUNDLE_ID = "com.maomao.app"
DEPLOYMENT_TARGET = "17.0"
SWIFT_VERSION = "5.0"


def oid(key: str) -> str:
    """Deterministic 24-hex-char object id."""
    return hashlib.md5(key.encode()).hexdigest()[:24].upper()


def pbx_str(value: str) -> str:
    """Old-style plist strings may stay bare only with [A-Za-z0-9_$./-]; anything else (e.g. the `+` in
    `AppStore+Remote.swift`) has to be quoted or Xcode refuses to open the project."""
    if re.fullmatch(r"[A-Za-z0-9_$./-]+", value):
        return value
    return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')


def collect():
    """Return (source_files, resource_files) as paths relative to SOURCE_DIR."""
    swift, resources = [], []
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, SOURCE_DIR)):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, os.path.join(ROOT, SOURCE_DIR))
        rel_dir = "" if rel_dir == "." else rel_dir

        # Asset catalogs are a single opaque resource, don't descend into them.
        # Resources/YardWeb (the web yard built by `pnpm --dir web build:ios`) goes in as one folder
        # reference so the bundle keeps its directory layout for the maomao:// scheme handler.
        for name in sorted(dirnames):
            if name.endswith(".xcassets") or (rel_dir == "Resources" and name == "YardWeb"):
                resources.append(os.path.join(rel_dir, name) if rel_dir else name)
        dirnames[:] = [d for d in dirnames if not d.endswith(".xcassets") and not (rel_dir == "Resources" and d == "YardWeb")]

        for name in sorted(filenames):
            if name.endswith(".png") and rel_dir.startswith("Resources/WorldTextures"):
                resources.append(os.path.join(rel_dir, name))
            if name.endswith(".m4a") and rel_dir.startswith("Resources/Audio"):
                resources.append(os.path.join(rel_dir, name))
            if name.endswith((".storyboard", ".xcprivacy")):
                resources.append(os.path.join(rel_dir, name) if rel_dir else name)
            if name.endswith((".swift", ".metal")):
                swift.append(os.path.join(rel_dir, name) if rel_dir else name)
    if "Resources/YardWeb" not in resources:
        resources.append("Resources/YardWeb")
    return sorted(swift), sorted(resources)


class Tree:
    """Folder tree mirroring the on-disk layout, rendered as PBXGroups."""

    def __init__(self, name, path):
        self.name = name
        self.path = path
        self.children = {}
        self.files = []

    def add(self, rel_path):
        parts = rel_path.split(os.sep)
        node = self
        for part in parts[:-1]:
            if part not in node.children:
                node.children[part] = Tree(part, part)
            node = node.children[part]
        node.files.append((parts[-1], rel_path))


def main():
    swift_files, resource_files = collect()
    if not swift_files:
        raise SystemExit("no Swift sources found under %s" % SOURCE_DIR)

    tree = Tree(PROJECT, PROJECT)
    for path in swift_files + resource_files:
        tree.add(path)

    lines = []
    out = lines.append

    out("// !$*UTF8*$!")
    out("{")
    out("\tarchiveVersion = 1;")
    out("\tclasses = {")
    out("\t};")
    out("\tobjectVersion = 56;")
    out("\tobjects = {")

    # ---- PBXBuildFile
    out("")
    out("/* Begin PBXBuildFile section */")
    for path in swift_files:
        out("\t\t%s /* %s in Sources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
            % (oid("build:" + path), os.path.basename(path), oid("file:" + path), os.path.basename(path)))
    for path in resource_files:
        out("\t\t%s /* %s in Resources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
            % (oid("build:" + path), os.path.basename(path), oid("file:" + path), os.path.basename(path)))
    out("/* End PBXBuildFile section */")

    # ---- PBXFileReference
    out("")
    out("/* Begin PBXFileReference section */")
    out('\t\t%s /* %s.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; '
        'includeInIndex = 0; path = %s.app; sourceTree = BUILT_PRODUCTS_DIR; };'
        % (oid("product"), PROJECT, PROJECT))
    for path in swift_files:
        name = os.path.basename(path)
        out('\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = %s; '
            'path = %s; sourceTree = "<group>"; };' % (oid("file:" + path), name, "sourcecode.metal" if path.endswith(".metal") else "sourcecode.swift", pbx_str(name)))
    for path in resource_files:
        name = os.path.basename(path)
        out('\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = %s; '
            'path = %s; sourceTree = "<group>"; };' % (oid("file:" + path), name, "folder.assetcatalog" if path.endswith(".xcassets") else "text.xml" if path.endswith(".xcprivacy") else "file.storyboard" if path.endswith(".storyboard") else "folder" if name == "YardWeb" else "audio.m4a" if path.endswith(".m4a") else "image.png", pbx_str(name)))
    out("/* End PBXFileReference section */")

    # ---- PBXFrameworksBuildPhase
    out("")
    out("/* Begin PBXFrameworksBuildPhase section */")
    out("\t\t%s /* Frameworks */ = {" % oid("frameworks"))
    out("\t\t\tisa = PBXFrameworksBuildPhase;")
    out("\t\t\tbuildActionMask = 2147483647;")
    out("\t\t\tfiles = (")
    out("\t\t\t);")
    out("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out("\t\t};")
    out("/* End PBXFrameworksBuildPhase section */")

    # ---- PBXGroup
    group_lines = []

    def emit_group(node, key):
        for child_name in sorted(node.children):
            emit_group(node.children[child_name], key + "/" + child_name)

        group_lines.append("\t\t%s /* %s */ = {" % (oid("group:" + key), node.name))
        group_lines.append("\t\t\tisa = PBXGroup;")
        group_lines.append("\t\t\tchildren = (")
        for child_name in sorted(node.children):
            group_lines.append("\t\t\t\t%s /* %s */,"
                               % (oid("group:" + key + "/" + child_name), child_name))
        for name, rel in sorted(node.files):
            group_lines.append("\t\t\t\t%s /* %s */," % (oid("file:" + rel), name))
        group_lines.append("\t\t\t);")
        if node.path is not None:
            group_lines.append("\t\t\tpath = %s;" % pbx_str(node.path))
        group_lines.append('\t\t\tsourceTree = "<group>";')
        group_lines.append("\t\t};")

    emit_group(tree, "root")

    out("")
    out("/* Begin PBXGroup section */")
    out("\t\t%s = {" % oid("mainGroup"))
    out("\t\t\tisa = PBXGroup;")
    out("\t\t\tchildren = (")
    out("\t\t\t\t%s /* %s */," % (oid("group:root"), PROJECT))
    out("\t\t\t\t%s /* Products */," % oid("productsGroup"))
    out("\t\t\t);")
    out('\t\t\tsourceTree = "<group>";')
    out("\t\t};")
    out("\t\t%s /* Products */ = {" % oid("productsGroup"))
    out("\t\t\tisa = PBXGroup;")
    out("\t\t\tchildren = (")
    out("\t\t\t\t%s /* %s.app */," % (oid("product"), PROJECT))
    out("\t\t\t);")
    out("\t\t\tname = Products;")
    out('\t\t\tsourceTree = "<group>";')
    out("\t\t};")
    lines.extend(group_lines)
    out("/* End PBXGroup section */")

    # ---- PBXNativeTarget
    out("")
    out("/* Begin PBXNativeTarget section */")
    out("\t\t%s /* %s */ = {" % (oid("target"), PROJECT))
    out("\t\t\tisa = PBXNativeTarget;")
    out("\t\t\tbuildConfigurationList = %s /* Build configuration list for PBXNativeTarget \"%s\" */;"
        % (oid("targetConfigList"), PROJECT))
    out("\t\t\tbuildPhases = (")
    out("\t\t\t\t%s /* Sources */," % oid("sources"))
    out("\t\t\t\t%s /* Frameworks */," % oid("frameworks"))
    out("\t\t\t\t%s /* Build YardWeb */," % oid("yardWeb"))
    out("\t\t\t\t%s /* Resources */," % oid("resources"))
    out("\t\t\t);")
    out("\t\t\tbuildRules = (")
    out("\t\t\t);")
    out("\t\t\tdependencies = (")
    out("\t\t\t);")
    out("\t\t\tname = %s;" % PROJECT)
    out("\t\t\tproductName = %s;" % PROJECT)
    out("\t\t\tproductReference = %s /* %s.app */;" % (oid("product"), PROJECT))
    out('\t\t\tproductType = "com.apple.product-type.application";')
    out("\t\t};")
    out("/* End PBXNativeTarget section */")

    # ---- PBXProject
    out("")
    out("/* Begin PBXProject section */")
    out("\t\t%s /* Project object */ = {" % oid("project"))
    out("\t\t\tisa = PBXProject;")
    out("\t\t\tattributes = {")
    out("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
    out("\t\t\t\tLastSwiftUpdateCheck = 1600;")
    out("\t\t\t\tLastUpgradeCheck = 1600;")
    out("\t\t\t\tTargetAttributes = {")
    out("\t\t\t\t\t%s = {" % oid("target"))
    out("\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;")
    out("\t\t\t\t\t};")
    out("\t\t\t\t};")
    out("\t\t\t};")
    out("\t\t\tbuildConfigurationList = %s /* Build configuration list for PBXProject \"%s\" */;"
        % (oid("projectConfigList"), PROJECT))
    out('\t\t\tcompatibilityVersion = "Xcode 14.0";')
    out("\t\t\tdevelopmentRegion = \"zh-Hans\";")
    out("\t\t\thasScannedForEncodings = 0;")
    out("\t\t\tknownRegions = (")
    out("\t\t\t\t\"zh-Hans\",")
    out("\t\t\t\tBase,")
    out("\t\t\t);")
    out("\t\t\tmainGroup = %s;" % oid("mainGroup"))
    out("\t\t\tproductRefGroup = %s /* Products */;" % oid("productsGroup"))
    out('\t\t\tprojectDirPath = "";')
    out('\t\t\tprojectRoot = "";')
    out("\t\t\ttargets = (")
    out("\t\t\t\t%s /* %s */," % (oid("target"), PROJECT))
    out("\t\t\t);")
    out("\t\t};")
    out("/* End PBXProject section */")

    # ---- PBXResourcesBuildPhase
    out("")
    out("/* Begin PBXResourcesBuildPhase section */")
    out("\t\t%s /* Resources */ = {" % oid("resources"))
    out("\t\t\tisa = PBXResourcesBuildPhase;")
    out("\t\t\tbuildActionMask = 2147483647;")
    out("\t\t\tfiles = (")
    for path in resource_files:
        out("\t\t\t\t%s /* %s in Resources */," % (oid("build:" + path), os.path.basename(path)))
    out("\t\t\t);")
    out("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out("\t\t};")
    out("/* End PBXResourcesBuildPhase section */")

    out("")
    out("/* Begin PBXShellScriptBuildPhase section */")
    out("\t\t%s /* Build YardWeb */ = {" % oid("yardWeb"))
    out("\t\t\tisa = PBXShellScriptBuildPhase;")
    out("\t\t\talwaysOutOfDate = 1;")
    out("\t\t\tbuildActionMask = 2147483647;")
    out('\t\t\tname = "Build YardWeb";')
    out('\t\t\toutputPaths = ("$(SRCROOT)/Maomao/Resources/YardWeb",);')
    out("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out("\t\t\tshellPath = /bin/sh;")
    out('\t\t\tshellScript = "sh \\"$SRCROOT/build_yard_web.sh\\"";')
    out("\t\t};")
    out("/* End PBXShellScriptBuildPhase section */")

    # ---- PBXSourcesBuildPhase
    out("")
    out("/* Begin PBXSourcesBuildPhase section */")
    out("\t\t%s /* Sources */ = {" % oid("sources"))
    out("\t\t\tisa = PBXSourcesBuildPhase;")
    out("\t\t\tbuildActionMask = 2147483647;")
    out("\t\t\tfiles = (")
    for path in swift_files:
        out("\t\t\t\t%s /* %s in Sources */," % (oid("build:" + path), os.path.basename(path)))
    out("\t\t\t);")
    out("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out("\t\t};")
    out("/* End PBXSourcesBuildPhase section */")

    # ---- XCBuildConfiguration
    project_common = [
        ("ALWAYS_SEARCH_USER_PATHS", "NO"),
        ("ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS", "YES"),
        ("CLANG_ANALYZER_NONNULL", "YES"),
        ("CLANG_ENABLE_MODULES", "YES"),
        ("CLANG_ENABLE_OBJC_ARC", "YES"),
        ("COPY_PHASE_STRIP", "NO"),
        ("ENABLE_STRICT_OBJC_MSGSEND", "YES"),
        ("ENABLE_USER_SCRIPT_SANDBOXING", "YES"),
        ("GCC_C_LANGUAGE_STANDARD", "gnu17"),
        ("IPHONEOS_DEPLOYMENT_TARGET", DEPLOYMENT_TARGET),
        ("LOCALIZATION_PREFERS_STRING_CATALOGS", "YES"),
        ("MTL_FAST_MATH", "YES"),
        ("SDKROOT", "iphoneos"),
        ("SWIFT_EMIT_LOC_STRINGS", "YES"),
    ]

    project_debug = project_common + [
        ("DEBUG_INFORMATION_FORMAT", "dwarf"),
        ("ENABLE_TESTABILITY", "YES"),
        ("GCC_DYNAMIC_NO_PIC", "NO"),
        ("GCC_OPTIMIZATION_LEVEL", "0"),
        ("GCC_PREPROCESSOR_DEFINITIONS", '(\n\t\t\t\t\t"DEBUG=1",\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t)'),
        ("MTL_ENABLE_DEBUG_INFO", "INCLUDE_SOURCE"),
        ("ONLY_ACTIVE_ARCH", "YES"),
        ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", '"DEBUG $(inherited)"'),
        ("SWIFT_OPTIMIZATION_LEVEL", "-Onone"),
    ]

    project_release = project_common + [
        ("DEBUG_INFORMATION_FORMAT", '"dwarf-with-dsym"'),
        ("ENABLE_NS_ASSERTIONS", "NO"),
        ("MTL_ENABLE_DEBUG_INFO", "NO"),
        ("SWIFT_COMPILATION_MODE", "wholemodule"),
        ("VALIDATE_PRODUCT", "YES"),
    ]

    target_common = [
        ("ASSETCATALOG_COMPILER_APPICON_NAME", "AppIcon"),
        ("CODE_SIGN_STYLE", "Automatic"),
        ("CODE_SIGN_ENTITLEMENTS", "Maomao/Maomao.entitlements"),
        ("CATTT_APNS_ENVIRONMENT", "development"),
        ("CURRENT_PROJECT_VERSION", "1"),
        ("ENABLE_PREVIEWS", "YES"),
        ("ENABLE_USER_SCRIPT_SANDBOXING", "NO"),
        ("GENERATE_INFOPLIST_FILE", "YES"),
        ("INFOPLIST_FILE", "Maomao/Info.plist"),
        ("INFOPLIST_KEY_UIApplicationSceneManifest_Generation", "YES"),
        ("INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents", "YES"),
        # 冷启动先显示与 3D 院子原生兜底相同的天空色，避免 SwiftUI 首帧前闪白。
        ("INFOPLIST_KEY_UILaunchStoryboardName", "LaunchScreen"),
        # 院子「跟着真实天气」只要大致位置（docs/方案/院子天气-真实与手动切换-方案-2026-09-16.md）。
        ("INFOPLIST_KEY_NSLocationWhenInUseUsageDescription", '"用大致位置让院子跟着你那里的天气下雨或放晴。"'),
        # 竖屏专用。整套设计都是 390 × 844 的竖屏。
        ("INFOPLIST_KEY_UISupportedInterfaceOrientations", "UIInterfaceOrientationPortrait"),
        ("LD_RUNPATH_SEARCH_PATHS", '(\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t)'),
        ("MARKETING_VERSION", "0.1"),
        ("PRODUCT_BUNDLE_IDENTIFIER", BUNDLE_ID),
        ("PRODUCT_NAME", '"$(TARGET_NAME)"'),
        ("SWIFT_EMIT_LOC_STRINGS", "YES"),
        ("SWIFT_VERSION", SWIFT_VERSION),
        ("TARGETED_DEVICE_FAMILY", '"1"'),
    ]

    def emit_config(key, name, settings):
        out("\t\t%s /* %s */ = {" % (oid(key), name))
        out("\t\t\tisa = XCBuildConfiguration;")
        out("\t\t\tbuildSettings = {")
        for setting, value in sorted(settings):
            out("\t\t\t\t%s = %s;" % (setting, value))
        out("\t\t\t};")
        out("\t\t\tname = %s;" % name)
        out("\t\t};")

    out("")
    out("/* Begin XCBuildConfiguration section */")
    emit_config("projectDebug", "Debug", project_debug)
    emit_config("projectRelease", "Release", project_release)
    emit_config("targetDebug", "Debug", target_common)
    emit_config("targetRelease", "Release", [(k,v) for k,v in target_common if k != "CATTT_APNS_ENVIRONMENT"] + [("CATTT_APNS_ENVIRONMENT", "production")])
    out("/* End XCBuildConfiguration section */")

    # ---- XCConfigurationList
    out("")
    out("/* Begin XCConfigurationList section */")
    for key, name, debug_key, release_key in [
        ("projectConfigList", 'Build configuration list for PBXProject "%s"' % PROJECT,
         "projectDebug", "projectRelease"),
        ("targetConfigList", 'Build configuration list for PBXNativeTarget "%s"' % PROJECT,
         "targetDebug", "targetRelease"),
    ]:
        out("\t\t%s /* %s */ = {" % (oid(key), name))
        out("\t\t\tisa = XCConfigurationList;")
        out("\t\t\tbuildConfigurations = (")
        out("\t\t\t\t%s /* Debug */," % oid(debug_key))
        out("\t\t\t\t%s /* Release */," % oid(release_key))
        out("\t\t\t);")
        out("\t\t\tdefaultConfigurationIsVisible = 0;")
        out("\t\t\tdefaultConfigurationName = Release;")
        out("\t\t};")
    out("/* End XCConfigurationList section */")

    out("\t};")
    out("\trootObject = %s /* Project object */;" % oid("project"))
    out("}")

    project_dir = os.path.join(ROOT, PROJECT + ".xcodeproj")
    with open(os.path.join(ROOT, SOURCE_DIR, "Info.plist"), "wb") as handle:
        plistlib.dump({
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
            "ITSAppUsesNonExemptEncryption": False,
            "CFBundleURLTypes": [{"CFBundleURLName": "com.maomao.pair", "CFBundleURLSchemes": ["maomao"]}],
            "NSLocalNetworkUsageDescription": "连接家里电脑上的团子，在同一个局域网里聊天和同步日记。",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        }, handle)
    os.makedirs(project_dir, exist_ok=True)
    with open(os.path.join(project_dir, "project.pbxproj"), "w") as handle:
        handle.write("\n".join(lines) + "\n")

    print("%d source files, %d resources → %s/project.pbxproj"
          % (len(swift_files), len(resource_files), PROJECT + ".xcodeproj"))


if __name__ == "__main__":
    main()
