import unittest
from dataclasses import replace
from wire_reference import (Input, Output, digest_limbs, h, intent_hash, native_io,
                            read_u, record, scriptnum, state_packet,
                            transition_hash, uint_le)


class WireTests(unittest.TestCase):
    def setUp(self):
        self.domain = h(b"test domain")
        self.params = h(b"test params")
        self.inputs = (Input(h(b"gate"), 0, 1000, h(b"gate program")),
                       Input(h(b"lane parent"), 2, 330, h(b"lane program")))
        self.outputs = (Output(800, h(b"change")),
                        Output(330, h(b"lane program"), 1), Output(0, b"proof extension"))

    def test_unsigned_high_bit_not_sign_magnitude(self):
        self.assertEqual(scriptnum(b"\x80"), 0)
        self.assertEqual(read_u(b"\x80", 0, 1), 128)
        self.assertEqual(read_u(b"\xff" * 8, 0, 8), 2**64 - 1)

    def test_unsigned_roundtrip_and_overflow(self):
        for width in (1, 2, 4, 8, 16, 32):
            for value in (0, 1, (1 << (8 * width)) - 1):
                self.assertEqual(read_u(uint_le(value, width), 0, width), value)
        for bad in (-1, 2**64):
            with self.assertRaises(ValueError):
                uint_le(bad, 8)

    def test_digest_limb_roundtrip(self):
        d = h(b"public statement")
        self.assertEqual(b"".join(uint_le(x, 4) for x in digest_limbs(d)), d)

    def test_parent_record_selected_by_vout_not_vin(self):
        records = (b"\0" * 160, b"A" * 160, b"B" * 160)
        p = state_packet(self.domain, self.params, records)
        self.assertEqual(record(p, self.domain, self.params, self.inputs[1].vout), records[2])
        self.assertNotEqual(record(p, self.domain, self.params, 1), records[2])

    def test_record_rejects_bad_domain_trailing_bytes_and_index(self):
        p = state_packet(self.domain, self.params, (b"A" * 160,))
        for q, domain, index in ((p, h(b"other"), 0), (p + b"\0", self.domain, 0),
                                 (p, self.domain, 1), (p, self.domain, -1)):
            with self.assertRaises(ValueError):
                record(q, domain, self.params, index)

    def test_native_digest_binds_recipient(self):
        modified = (replace(self.outputs[0], program=h(b"attacker")), *self.outputs[1:])
        self.assertNotEqual(native_io(self.inputs, self.outputs), native_io(self.inputs, modified))

    def test_native_digest_binds_value_and_outpoint(self):
        original = native_io(self.inputs, self.outputs)
        self.assertNotEqual(original, native_io(self.inputs,
            (replace(self.outputs[0], value=799), *self.outputs[1:])))
        self.assertNotEqual(original, native_io(
            (self.inputs[0], replace(self.inputs[1], txid=h(b"new head"))), self.outputs))

    def test_native_digest_binds_sequence(self):
        changed = (self.inputs[0], replace(self.inputs[1], sequence=1))
        self.assertNotEqual(native_io(self.inputs, self.outputs), native_io(changed, self.outputs))

    def test_proof_carrier_excluded_without_dropping_effects(self):
        changed = (*self.outputs[:-1], replace(self.outputs[-1], program=b"different proof bytes"))
        self.assertEqual(native_io(self.inputs, self.outputs), native_io(self.inputs, changed))

    def test_excluded_extension_cannot_carry_funds(self):
        for ext in (replace(self.outputs[-1], value=1), replace(self.outputs[-1], asset_count=1)):
            with self.assertRaises(ValueError):
                native_io(self.inputs, (*self.outputs[:-1], ext))

    def test_transition_binds_each_relevant_packet(self):
        io = native_io(self.inputs, self.outputs)
        args = [self.domain, self.params, b"intent ciphertexts", io, b"plan", b"state", b"assets"]
        expected = transition_hash(*args)
        for i in (2, 4, 5, 6):
            changed = args[:]
            changed[i] += b"!"
            self.assertNotEqual(expected, transition_hash(*changed))

    def test_rebase_changes_state_statement_not_intent(self):
        body = b"same authorized private intent"
        ih = intent_hash(self.domain, self.params, body)
        changed = (self.inputs[0], replace(self.inputs[1], txid=h(b"fresh lane")))
        old = transition_hash(self.domain, self.params, body, native_io(self.inputs, self.outputs),
                              b"old plan", b"old state", b"assets")
        new = transition_hash(self.domain, self.params, body, native_io(changed, self.outputs),
                              b"new plan", b"new state", b"assets")
        self.assertNotEqual(old, new)
        self.assertEqual(ih, intent_hash(self.domain, self.params, body))


if __name__ == "__main__":
    unittest.main()
