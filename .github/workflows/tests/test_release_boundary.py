"""Static release boundary checks. Run with Python 3 and PyYAML; no GitHub calls."""
import re
import unittest
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[1] / 'build-windows.yml'


def enabled(step, event, ref):
    expression = str(step.get('if', 'True'))
    expression = expression.removeprefix('${{').removesuffix('}}').strip()
    expression = expression.replace('github.event_name', repr(event)).replace('github.ref', repr(ref))
    expression = expression.replace('&&', ' and ').replace('||', ' or ')
    expression = re.sub(r'!(?!=)', ' not ', expression)
    return bool(eval(expression, {'__builtins__': {}, 'startsWith': str.startswith}, {}))


class ReleaseBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.safe_load(WORKFLOW.read_text())
        cls.steps = cls.workflow['jobs']['build']['steps']
        cls.builds = [s for s in cls.steps if s.get('uses') == 'tauri-apps/tauri-action@v0']

    def test_event_matrix(self):
        for event, ref, release in [
            ('push', 'refs/heads/main', False),
            ('workflow_dispatch', 'refs/heads/main', False),
            ('workflow_dispatch', 'refs/tags/v1.2.27', False),
            ('push', 'refs/tags/v1.2.27', True),
            ('push', 'refs/tags/v2.0.0-beta.1', True),
            ('push', 'refs/tags/other', False),
            ('push', 'refs/heads/version-test', False),
        ]:
            with self.subTest(event=event, ref=ref):
                active = [s for s in self.builds if enabled(s, event, ref)]
                self.assertEqual(len(active), 1, 'exactly one build path must run')
                inputs = active[0]['with']
                self.assertEqual(inputs['projectPath'], 'apps/desktop')
                if release:
                    self.assertEqual(inputs['tagName'], 'v__VERSION__')
                    self.assertEqual(inputs['releaseName'], 'dssh v__VERSION__')
                    self.assertIs(inputs['releaseDraft'], True)
                    self.assertIs(inputs['includeUpdaterJson'], True)
                    self.assertEqual(active[0]['env']['GITHUB_TOKEN'], '${{ secrets.GITHUB_TOKEN }}')
                else:
                    self.assertNotIn('tagName', inputs)
                    self.assertNotIn('releaseId', inputs)
                    self.assertNotIn('releaseName', inputs)
                    self.assertIs(inputs['includeUpdaterJson'], False)
                    self.assertNotIn('GITHUB_TOKEN', active[0]['env'])
                for key in ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']:
                    self.assertEqual(active[0]['env'][key], '${{ secrets.' + key + ' }}')

    def test_triggers_matrix_and_artifacts_preserved(self):
        # PyYAML's YAML 1.1 loader treats the unquoted key "on" as True.
        triggers = self.workflow.get('on', self.workflow.get(True))
        self.assertEqual(triggers['push'], {'branches': ['main'], 'tags': ['v*']})
        self.assertIn('workflow_dispatch', triggers)
        self.assertEqual(self.workflow['jobs']['build']['strategy']['matrix']['os'],
                         ['windows-latest', 'macos-latest', 'ubuntu-22.04'])
        artifact = [s for s in self.steps if s.get('uses') == 'actions/upload-artifact@v4']
        self.assertEqual(len(artifact), 1)
        self.assertNotIn('if', artifact[0])
        for extension in ['msi', 'exe', 'dmg', 'app.tar.gz', 'deb', 'rpm', 'AppImage']:
            self.assertIn('**/*.' + extension, artifact[0]['with']['path'])


if __name__ == '__main__':
    unittest.main()
