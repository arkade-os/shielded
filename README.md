# Arkade shielded protocol — design review

**Experimental; not a deployed or functioning private payment system.**

This branch contains the design, explicit circuit requirements, and a transparent
state-machine model. Run `python model/reference_model.py` for the 13 model tests.
Those tests do not implement cryptography or validate an Arkade transaction.

The compiler-specific packet-backed implementation is proposed separately on
`feat/covenant-scaffold`, based on this branch. Older brainstorms are not normative.
Keep application source and discussion private. See SECURITY.md.
