package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
)

const (
	rollupStatePacket  = 0x87
	rollupMaxSlots     = 11 // slots + 5 pairs fill one 16-pair OP_ECPAIRING
	rollupTunnelScript = 1
	rollupTunnelAssets = 4
)

var rollupProofFields = []string{"Ax", "Ay", "B0", "B1", "B2", "B3", "Cx", "Cy"}

type rollupLeafConfig struct {
	Slots  int
	Kind   byte // 0 spend, 1 join
	Client rollupKey
	Batch  rollupKey
}

type rollupLeaf struct {
	Script []byte
	ECMul  int
	Pairs  int
}

// rollupWitnessNames is the batch leaf's witness, bottom to top: the batch
// proof, then per slot from the last to the first: its proof, pub, deposit,
// withdraw, boundaryAsset and destination (both 32-byte LE, empty for 0).
func rollupWitnessNames(slots int) []string {
	var names []string
	for _, f := range rollupProofFields {
		names = append(names, "b"+f)
	}
	for i := slots - 1; i >= 0; i-- {
		for _, f := range append(append([]string(nil), rollupProofFields...), "pub", "dep", "wd", "a", "d") {
			names = append(names, fmt.Sprintf("%s_%d", f, i))
		}
	}
	return names
}

func buildRollupBatchLeaf(c rollupLeafConfig) (rollupLeaf, error) {
	if c.Slots < 1 || c.Slots > rollupMaxSlots || c.Kind > 1 {
		return rollupLeaf{}, errors.New("rollup leaf needs 1-11 slots and kind 0 or 1")
	}
	if len(c.Client.IC) != 6 || len(c.Batch.IC) != c.Slots+2 {
		return rollupLeaf{}, errors.New("rollup keys need 5 client and slots+1 batch public inputs")
	}
	if err := rollupSharedSetup(c.Client, c.Batch); err != nil {
		return rollupLeaf{}, err
	}
	n := c.Slots
	s := newRollupStack(rollupWitnessNames(n))
	at := func(f string, i int) string { return fmt.Sprintf("%s_%d", f, i) }
	pair := func(i, j int) string { return fmt.Sprintf("p%d_%d", i, j) }

	s.op(arkade.OP_PUSHCURRENTINPUTINDEX, 0, "idx")
	s.op(txscript.OP_NOT, 1, "head")
	s.op(txscript.OP_VERIFY, 1)
	emitRollupBinding(s, c.Kind, n)

	var alt []string
	for i := 0; i < n; i++ {
		first := i == 0
		r := at("r", i)
		s.pick("seed", "x")
		s.small(int64(i+1), "i")
		s.op(arkade.OP_CAT, 2, "x")
		s.op(txscript.OP_SHA256, 1, "h")
		s.small(0, "start")
		s.small(16, "len")
		s.op(arkade.OP_SUBSTR, 3, "h16")
		s.op(arkade.OP_BIN2NUM, 1, "signed")
		s.op(txscript.OP_ABS, 1, r)

		s.roll(at("Ax", i))
		s.roll(at("Ay", i))
		s.pick(r, "k")
		s.small(arkade.CurveAltBN128, "curve")
		s.op(arkade.OP_ECMUL, 4, pair(i, 0), pair(i, 1))
		for j := 0; j < 4; j++ {
			s.roll(at(fmt.Sprintf("B%d", j), i))
			s.rename(at(fmt.Sprintf("B%d", j), i), pair(i, j+2))
		}
		for j := 5; j >= 0; j-- {
			s.op(txscript.OP_TOALTSTACK, 1)
			alt = append(alt, pair(i, j))
		}
		s.roll(at("Cx", i))
		s.roll(at("Cy", i))
		s.pick(r, "k")
		s.small(arkade.CurveAltBN128, "curve")
		s.op(arkade.OP_ECMUL, 4, "rcx", "rcy")
		s.ecAdd("scx", "scy", first, "rcx", "rcy")

		pub := at("pub", i)
		s.number(c.Batch.IC[i+1][0], "x")
		s.number(c.Batch.IC[i+1][1], "y")
		s.pick(pub, "k")
		s.small(arkade.CurveAltBN128, "curve")
		s.op(arkade.OP_ECMUL, 4, "bxi", "byi")
		s.ecAdd("bx", "by", first, "bxi", "byi")

		s.roll(pub)
		s.pick(r, "k")
		s.op(txscript.OP_MUL, 2, "u")
		s.accumulate("s0", "u", first)
		for k, item := range []string{at("dep", i), at("wd", i), at("a", i), at("d", i)} {
			s.pick(item, "x")
			if k >= 2 {
				s.op(arkade.OP_BIN2NUM, 1, "x")
			}
			s.pick(r, "k")
			s.op(txscript.OP_MUL, 2, "u")
			s.accumulate(fmt.Sprintf("s%d", k+1), "u", first)
		}
		s.roll(r)
		s.accumulate("sr", r, first)
		emitRollupZeroLegs(s, i)
	}

	for len(alt) > 0 {
		s.b.AddOp(txscript.OP_FROMALTSTACK)
		s.push(alt[len(alt)-1])
		alt = alt[:len(alt)-1]
	}
	emitRollupPairing(s, c, n)
	emitRollupNativeFinals(s)
	script, err := s.b.Script()
	if err != nil {
		return rollupLeaf{}, err
	}
	return rollupLeaf{Script: script, ECMul: s.ecmul, Pairs: n + 5}, nil
}

// emitRollupBinding rebuilds the 101-byte statement preimage from the parent's
// state packet and this transaction's, and seeds Fiat-Shamir with its hash and
// the hash of this input's whole witness.
func emitRollupBinding(s *rollupStack, kind byte, n int) {
	s.b.AddData([]byte{'S', 'H', 2, kind, byte(n)})
	s.push("pre")
	s.small(rollupStatePacket, "type")
	s.small(0, "vin")
	s.op(arkade.OP_INSPECTINPUTPACKET, 2, "old", "ok")
	s.op(txscript.OP_VERIFY, 1)
	s.small(0, "start")
	s.small(32, "len")
	s.op(arkade.OP_SUBSTR, 3, "old")
	s.op(arkade.OP_CAT, 2, "pre")
	s.small(rollupStatePacket, "type")
	s.op(arkade.OP_INSPECTPACKET, 1, "new", "ok")
	s.op(txscript.OP_VERIFY, 1)
	s.op(txscript.OP_SIZE, 0, "size")
	s.small(64, "64")
	s.op(txscript.OP_NUMEQUALVERIFY, 2)
	s.op(arkade.OP_CAT, 2, "binding")
	s.op(txscript.OP_SHA256, 1, "h")
	s.op(txscript.OP_DUP, 0, "h2")
	s.le248("stb")
	s.op(arkade.OP_BIN2NUM, 1, "st")
	s.op(txscript.OP_SWAP, 2, "st", "h")
	s.small(0, "vin")
	s.op(arkade.OP_INSPECTINPUTARKADEWITNESSHASH, 1, "w")
	s.op(arkade.OP_CAT, 2, "hw")
	s.op(txscript.OP_SHA256, 1, "seed")
	s.number(rollupScalarField, "q")
}

// emitRollupZeroLegs refuses every boundary leg.
func emitRollupZeroLegs(s *rollupStack, i int) {
	for _, f := range []string{"dep", "wd", "a", "d"} {
		s.roll(fmt.Sprintf("%s_%d", f, i))
		s.op(txscript.OP_SIZE, 0, "size")
		s.op(txscript.OP_NIP, 2, "size")
		s.op(txscript.OP_NOT, 1, "zero")
		s.op(txscript.OP_VERIFY, 1)
	}
}

// emitRollupPairing checks every client proof and the batch proof in one
// OP_ECPAIRING. Client proof i is weighted by r_i and the batch proof by 1.
func emitRollupPairing(s *rollupStack, c rollupLeafConfig, n int) {
	curve := int64(arkade.CurveAltBN128)
	g2 := func(p rollupG2, prefix string) {
		for j, v := range p {
			s.number(v, fmt.Sprintf("%s_%d", prefix, j+2))
		}
	}
	for j, f := range rollupProofFields[:6] {
		s.roll("b" + f)
		s.rename("b"+f, fmt.Sprintf("pb_%d", j))
	}
	s.number(c.Client.Alpha[0], "x")
	s.number(c.Client.Alpha[1], "y")
	s.pick("sr", "k")
	s.op(txscript.OP_1ADD, 1, "k")
	s.pick("q", "q2")
	s.op(txscript.OP_MOD, 2, "k")
	s.small(curve, "curve")
	s.op(arkade.OP_ECMUL, 4, "ga_0", "ga_1")
	g2(c.Client.NegBeta, "ga")

	s.number(c.Client.IC[0][0], "x")
	s.number(c.Client.IC[0][1], "y")
	s.roll("sr")
	s.pick("q", "q2")
	s.op(txscript.OP_MOD, 2, "k")
	s.small(curve, "curve")
	s.op(arkade.OP_ECMUL, 4, "lx", "ly")
	for k := 0; k < 5; k++ {
		s.number(c.Client.IC[k+1][0], "x")
		s.number(c.Client.IC[k+1][1], "y")
		s.roll(fmt.Sprintf("s%d", k))
		s.pick("q", "q2")
		s.op(txscript.OP_MOD, 2, "k")
		s.small(curve, "curve")
		s.op(arkade.OP_ECMUL, 4, "mx", "my")
		s.ecAdd("lx", "ly", false, "mx", "my")
	}
	s.roll("bx")
	s.roll("by")
	s.ecAdd("lx", "ly", false, "bx", "by")
	s.number(c.Batch.IC[0][0], "x")
	s.number(c.Batch.IC[0][1], "y")
	s.ecAdd("lx", "ly", false, "x", "y")
	s.number(c.Batch.IC[n+1][0], "x")
	s.number(c.Batch.IC[n+1][1], "y")
	s.roll("st")
	s.small(curve, "curve")
	s.op(arkade.OP_ECMUL, 4, "sx", "sy")
	s.ecAdd("lx", "ly", false, "sx", "sy")
	s.rename("lx", "gx_0")
	s.rename("ly", "gx_1")
	g2(c.Client.NegGamma, "gx")
	s.roll("scx")
	s.roll("scy")
	s.rename("scx", "gc_0")
	s.rename("scy", "gc_1")
	g2(c.Client.NegDelta, "gc")
	s.roll("bCx")
	s.roll("bCy")
	s.rename("bCx", "gb_0")
	s.rename("bCy", "gb_1")
	g2(c.Batch.NegDelta, "gb")

	var want []string
	for i := n - 1; i >= 0; i-- {
		for j := 0; j < 6; j++ {
			want = append(want, fmt.Sprintf("p%d_%d", i, j))
		}
	}
	for _, p := range []string{"pb", "ga", "gx", "gc", "gb"} {
		for j := 0; j < 6; j++ {
			want = append(want, fmt.Sprintf("%s_%d", p, j))
		}
	}
	if got := strings.Join(s.items[len(s.items)-len(want):], ","); got != strings.Join(want, ",") {
		panic("rollup pairing arguments out of order: " + got)
	}
	s.small(int64(n+5), "count")
	s.small(curve, "curve")
	s.op(arkade.OP_ECPAIRING, 6*(n+5)+2, "ok")
	s.op(txscript.OP_VERIFY, 1)
}

// emitRollupNativeFinals keeps the head's value, script and assets, then
// leaves a single true.
func emitRollupNativeFinals(s *rollupStack) {
	s.small(0, "vout")
	s.op(arkade.OP_INSPECTOUTPUTVALUE, 1, "out")
	s.small(0, "vin")
	s.op(arkade.OP_INSPECTINPUTVALUE, 1, "in")
	s.op(txscript.OP_NUMEQUALVERIFY, 2)
	s.small(0, "vout")
	s.small(rollupTunnelScript|rollupTunnelAssets, "flags")
	s.small(0, "exceptions")
	s.op(arkade.OP_TUNNEL, 3, "tunnel")
	s.op(txscript.OP_VERIFY, 1)
	for len(s.items) > 1 {
		s.op(txscript.OP_2DROP, 2)
	}
	if len(s.items) == 1 {
		s.op(txscript.OP_DROP, 1)
	}
	s.op(txscript.OP_1, 0, "true")
}
