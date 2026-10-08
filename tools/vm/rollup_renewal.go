package main

import (
	"errors"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
)

// buildRollupRenewalLeaf renews pool coins unchanged, in a register intent only.
// Its witness is the operator's BIP340 signature over sha256(cosigners JSON ||
// head outpoint), because arkd re-queues an unconfirmed intent and locks its coins.
func buildRollupRenewalLeaf(token asset.AssetId, operator []byte) ([]byte, error) {
	if len(operator) != 32 {
		return nil, errors.New("renewal operator key must be 32-byte x-only")
	}
	b := txscript.NewScriptBuilder()
	b.AddData([]byte("type")).AddOp(arkade.OP_INSPECTINTENTMESSAGE).AddOp(txscript.OP_VERIFY)
	b.AddData([]byte("register")).AddOp(txscript.OP_EQUALVERIFY)
	b.AddData([]byte("cosigners_public_keys")).AddOp(arkade.OP_INSPECTINTENTMESSAGE).AddOp(txscript.OP_VERIFY)
	b.AddInt64(1).AddOp(arkade.OP_INSPECTINPUTOUTPOINT).AddOp(arkade.OP_CAT).AddOp(arkade.OP_CAT).AddOp(txscript.OP_SHA256)
	b.AddData(operator).AddOp(arkade.OP_CHECKSIGFROMSTACK).AddOp(txscript.OP_VERIFY)
	b.AddOp(arkade.OP_PUSHCURRENTINPUTINDEX).AddOp(txscript.OP_1SUB)
	b.AddInt64(rollupTunnelScript | rollupTunnelValue | rollupTunnelAssets).AddInt64(0).AddOp(arkade.OP_TUNNEL).AddOp(txscript.OP_VERIFY)
	b.AddInt64(1).AddData(token.Txid[:]).AddInt64(int64(token.Index)).AddOp(arkade.OP_INSPECTINASSETLOOKUP)
	b.AddOp(txscript.OP_VERIFY).AddInt64(1).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddInt64(rollupStatePacket).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddInt64(rollupStatePacket).AddInt64(1).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_EQUAL)
	return b.Script()
}
