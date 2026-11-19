import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest


IOS = Path(__file__).resolve().parent


class ArchiveBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ios = self.root / "ios"
        self.ios.mkdir()
        self.output = self.ios / "Maomao/Resources/YardWeb"
        shutil.copy(IOS / "build_yard_web.sh", self.ios)

    def run_script(self, **env):
        return subprocess.run(
            ["/bin/sh", str(self.ios / "build_yard_web.sh")],
            env={**os.environ, **env}, capture_output=True, text=True,
        )

    def test_skip_requires_existing_assets(self):
        result = self.run_script(SKIP_YARD_WEB_BUILD="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error:", result.stderr)
        self.output.mkdir(parents=True)
        (self.output / "app.html").touch()
        result = self.run_script(SKIP_YARD_WEB_BUILD="1", PATH="/usr/bin:/bin")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("跳过", result.stdout)

    def test_build_invokes_pnpm_and_propagates_failure(self):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        pnpm = bin_dir / "pnpm"
        pnpm.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\nexit "${TEST_EXIT:-0}"\n')
        pnpm.chmod(0o755)
        env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "SKIP_YARD_WEB_BUILD": "0"}
        result = self.run_script(**env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["--dir", str(self.root / "web"), "build:ios"])
        self.assertEqual(self.run_script(**env, TEST_EXIT="23").returncode, 23)

    def test_generator_includes_absent_yard_and_privacy(self):
        app = self.ios / "Maomao"
        app.mkdir()
        (app / "App.swift").write_text("import SwiftUI\n")
        shutil.copy(IOS / "Maomao/PrivacyInfo.xcprivacy", app)
        shutil.copy(IOS / "generate_project.py", self.ios)
        subprocess.run(["python3", str(self.ios / "generate_project.py")], check=True, capture_output=True)
        project = (self.ios / "Maomao.xcodeproj/project.pbxproj").read_text()
        self.assertIn("PrivacyInfo.xcprivacy in Resources", project)
        self.assertIn("YardWeb in Resources", project)
        phases = project.split("buildPhases = (", 1)[1].split(");", 1)[0]
        self.assertLess(phases.index("Build YardWeb"), phases.index("Resources"))
        self.assertIn("ENABLE_USER_SCRIPT_SANDBOXING = NO", project)
        info = plistlib.loads((app / "Info.plist").read_bytes())
        self.assertIs(info["ITSAppUsesNonExemptEncryption"], False)
        self.assertEqual(info["CFBundleVersion"], "$(CURRENT_PROJECT_VERSION)")
        self.assertEqual(info["CFBundleShortVersionString"], "$(MARKETING_VERSION)")
        self.assertEqual(info["CFBundleURLTypes"][0]["CFBundleURLSchemes"], ["maomao"])
        self.assertTrue(info["NSAppTransportSecurity"]["NSAllowsLocalNetworking"])
        self.assertIn("局域网", info["NSLocalNetworkUsageDescription"])


if __name__ == "__main__":
    unittest.main()
