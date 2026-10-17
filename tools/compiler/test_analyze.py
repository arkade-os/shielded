import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('analyze.py')
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('analyze', SCRIPT)
ANALYZE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ANALYZE)


def artifact(tokens, name='batch'):
    return {'functions': [{'name': name, 'arkade': {'asm': tokens}}]}


class AnalyzeTest(unittest.TestCase):
    def test_counts_opcodes_and_pushes_without_estimating_weight(self):
        tokens = ['OP_PICK', 'OP_PICK', 'OP_NIP', 'OP_ECMUL', 'OP_ECPAIRING',
                  'OP_1', '0', '-1', str(1 << 63), str(-(1 << 63)), '0x00', '<alpha.x>']
        row = ANALYZE.summarize(artifact(tokens))['functions']['batch']
        self.assertEqual((row['asmTokens'], row['pushTokens'], row['wideIntegerPushes']), (12, 7, 1))
        self.assertEqual(row['opcodes']['OP_PICK'], 2)
        self.assertEqual(row['opcodes']['OP_ROLL'], 0)
        self.assertEqual(row['opcodes']['OP_PUT'], 0)

    def test_future_opcode_spelling_is_visible_without_semantic_validation(self):
        row = ANALYZE.summarize(artifact(['OP_FUTURE']))['functions']['batch']
        self.assertEqual(row['opcodes']['OP_FUTURE'], 1)

    def test_malformed_artifacts_tokens_and_duplicate_names_fail(self):
        invalid = [None, {}, {'functions': [None]}, {'functions': [{'name': ''}]},
                   {'functions': [{'name': 'batch', 'arkade': None}]},
                   artifact(['hello']), artifact(['0x1']), artifact(['OP_bad']), artifact([1])]
        duplicate = artifact([])
        duplicate['functions'] += [{'name': 'batch'}]
        invalid.append(duplicate)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ANALYZE.summarize(value)

    def test_non_arkade_functions_are_omitted(self):
        self.assertEqual(ANALYZE.summarize({'functions': [{'name': 'bitcoin'}]}), {'functions': {}})

    def test_delta_counts_added_removed_and_modified_functions(self):
        old = ANALYZE.summarize(artifact(['OP_PICK', 'OP_NIP', '1']))
        new = ANALYZE.summarize(artifact(['OP_ROLL', str(1 << 63)]))
        delta = ANALYZE.compare(old, new)['functions']['batch']
        self.assertEqual((delta['asmTokens'], delta['pushTokens'], delta['wideIntegerPushes']), (-1, 0, 1))
        self.assertEqual((delta['opcodes']['OP_PICK'], delta['opcodes']['OP_ROLL']), (-1, 1))
        empty = {'functions': {}}
        self.assertEqual(ANALYZE.compare(empty, new)['functions']['batch']['asmTokens'], 2)
        self.assertEqual(ANALYZE.compare(old, empty)['functions']['batch']['asmTokens'], -3)

    def test_cli_emits_deterministic_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'artifact.json'
            path.write_text(json.dumps(artifact(['OP_PUT'])), encoding='utf-8')
            command = [sys.executable, '-I', str(SCRIPT), str(path), str(path)]
            first = subprocess.run(command, capture_output=True, text=True)
            second = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(first.stdout, second.stdout)
            result = json.loads(first.stdout)
            self.assertEqual(result['unit'], ANALYZE.UNIT)
            self.assertEqual(result['delta']['functions']['batch']['opcodes']['OP_PUT'], 0)


if __name__ == '__main__':
    unittest.main()
