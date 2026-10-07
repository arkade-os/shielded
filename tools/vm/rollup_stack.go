package main

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
)

// rollupStack emits script against a named model of the data stack, so every
// PICK and ROLL depth is computed rather than counted by hand.
type rollupStack struct {
	b     *txscript.ScriptBuilder
	items []string
	ecmul int
}

func newRollupStack(witness []string) *rollupStack {
	return &rollupStack{b: txscript.NewScriptBuilder(), items: append([]string(nil), witness...)}
}

func (s *rollupStack) push(names ...string) { s.items = append(s.items, names...) }

func (s *rollupStack) depth(name string) int {
	for i := len(s.items) - 1; i >= 0; i-- {
		if s.items[i] == name {
			return len(s.items) - 1 - i
		}
	}
	panic("rollup stack has no item " + name)
}

func (s *rollupStack) op(code byte, pops int, outs ...string) {
	if pops > len(s.items) {
		panic(fmt.Sprintf("opcode 0x%x pops %d of %d items", code, pops, len(s.items)))
	}
	s.b.AddOp(code)
	s.items = s.items[:len(s.items)-pops]
	s.push(outs...)
	if code == arkade.OP_ECMUL {
		s.ecmul++
	}
}

func (s *rollupStack) pick(name, as string) {
	s.b.AddInt64(int64(s.depth(name))).AddOp(txscript.OP_PICK)
	s.push(as)
}

func (s *rollupStack) roll(name string) {
	d := s.depth(name)
	if d == 0 {
		return
	}
	s.b.AddInt64(int64(d)).AddOp(txscript.OP_ROLL)
	i := len(s.items) - 1 - d
	s.items = append(append(s.items[:i:i], s.items[i+1:]...), name)
}

func (s *rollupStack) rename(from, to string) { s.items[len(s.items)-1-s.depth(from)] = to }

func (s *rollupStack) number(v *big.Int, as string) {
	s.b.AddData(stockScriptNumBytes(v))
	s.push(as)
}

func (s *rollupStack) small(v int64, as string) {
	s.b.AddInt64(v)
	s.push(as)
}

// zeroByte pushes [0x00]; the builder would otherwise turn it into OP_0.
func (s *rollupStack) zeroByte(as string) {
	s.b.AddOps([]byte{txscript.OP_DATA_1, 0x00})
	s.push(as)
}

// ifElse pops the condition; both branches must leave the same stack shape.
func (s *rollupStack) ifElse(then, otherwise func()) {
	s.op(txscript.OP_IF, 1)
	start := append([]string(nil), s.items...)
	then()
	end := append([]string(nil), s.items...)
	s.items = append([]string(nil), start...)
	if otherwise != nil {
		s.b.AddOp(txscript.OP_ELSE)
		otherwise()
	}
	if strings.Join(s.items, ",") != strings.Join(end, ",") {
		panic(fmt.Sprintf("rollup branches leave different stacks:\n%v\n%v", end, s.items))
	}
	s.b.AddOp(txscript.OP_ENDIF)
}

func (s *rollupStack) accumulate(sum, term string, first bool) {
	if first {
		s.rename(term, sum)
		return
	}
	s.roll(sum)
	s.op(txscript.OP_ADD, 2, sum)
}

// ecAdd folds the point on top of the stack into the named accumulator.
func (s *rollupStack) ecAdd(x, y string, first bool, px, py string) {
	if first {
		s.rename(px, x)
		s.rename(py, y)
		return
	}
	s.roll(x)
	s.roll(y)
	s.small(arkade.CurveAltBN128, "curve")
	s.op(arkade.OP_ECADD, 5, x, y)
}

// le248 turns a 32-byte digest into the 32-byte little-endian encoding of
// sha256-le-248: its first 31 bytes and a zero top byte.
func (s *rollupStack) le248(as string) {
	s.small(0, "start")
	s.small(31, "len")
	s.op(arkade.OP_SUBSTR, 3, "h31")
	s.zeroByte("zero")
	s.op(arkade.OP_CAT, 2, as)
}

func (s *rollupStack) nonEmpty(item, as string) {
	s.pick(item, "x")
	s.op(txscript.OP_SIZE, 0, "size")
	s.op(txscript.OP_NIP, 2, "size")
	s.op(txscript.OP_0NOTEQUAL, 1, as)
}
