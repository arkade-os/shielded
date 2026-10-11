import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('generate.py')
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('generate', SCRIPT)
GEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GEN)


class GenerateTest(unittest.TestCase):
    def setUp(self):
        self.bindings = {name: {'int': '1'} for name in GEN.FIELDS}

    def test_generation_is_deterministic_and_binds_the_statement_kind(self):
        source = GEN.generate(self.bindings, 0)
        self.assertEqual(source, GEN.generate(dict(reversed(list(self.bindings.items()))), 0))
        self.assertIn('contract RollupBatch()', source)
        self.assertIn('function batch(Proof bp, Slot[11] slots)', source)
        self.assertIn('ECPoint[16] g1', source)
        self.assertIn('sha256(0x534802000b +', source)
        joined = GEN.generate(self.bindings, 1)
        self.assertEqual(joined, source.replace('0x534802000b', '0x534802010b'))

    def test_invalid_kinds_are_rejected(self):
        for kind in (-1, 2, True, '0'):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'kind'):
                GEN.generate(self.bindings, kind)

    def test_verification_key_dimensions_are_exact(self):
        for key in ('clientIC.5.y', 'batchIC.12.y', 'negDeltaBatch.yC0'):
            invalid = copy.deepcopy(self.bindings)
            del invalid[key]
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'exactly'):
                GEN.generate(invalid, 0)
        self.bindings['batchIC.13.x'] = {'int': '1'}
        with self.assertRaisesRegex(ValueError, 'exactly'):
            GEN.generate(self.bindings, 0)

    def test_field_integer_encoding_and_range_are_checked(self):
        for value in (None, True, 1, '', '-1', '+1', '1.0', '１', str(GEN.P)):
            invalid = copy.deepcopy(self.bindings)
            invalid['alpha.x'] = {'int': value}
            with self.subTest(value=value), self.assertRaises(ValueError):
                GEN.generate(invalid, 0)
        self.bindings['alpha.x'] = {'int': str(GEN.P - 1)}
        self.bindings['alpha.y'] = {'int': '0'}
        self.assertIn(str(GEN.P - 1), GEN.generate(self.bindings, 0))

    def test_binding_shape_is_checked(self):
        for row in (None, '1', {'int': '1', 'bytes': '01'}, {}):
            invalid = copy.deepcopy(self.bindings)
            invalid['alpha.x'] = row
            with self.subTest(row=row), self.assertRaises(ValueError):
                GEN.generate(invalid, 0)

    def test_cli_writes_valid_source_and_preserves_output_on_bad_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindings, output = root / 'bindings.json', root / 'batch.ark'
            bindings.write_text(json.dumps(self.bindings), encoding='utf-8')
            command = [sys.executable, '-I', str(SCRIPT), str(bindings), '1', str(output)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            source = output.read_text(encoding='utf-8')
            self.assertEqual(source, GEN.generate(self.bindings, 1))
            bindings.write_text('{}', encoding='utf-8')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('exactly', result.stderr)
            self.assertEqual(output.read_text(encoding='utf-8'), source)


if __name__ == '__main__':
    unittest.main()
