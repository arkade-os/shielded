import argparse
import json
from pathlib import Path

Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617
N = 11

P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
FIELDS = (
    ['alpha.' + axis for axis in ('x', 'y')]
    + ['%s.%d.%s' % (name, i, axis)
       for name, count in (('clientIC', 6), ('batchIC', N + 2))
       for i in range(count) for axis in ('x', 'y')]
    + [name + '.' + axis
       for name in ('negBeta', 'negGamma', 'negDeltaClient', 'negDeltaBatch')
       for axis in ('xC1', 'xC0', 'yC1', 'yC0')]
)


def checked(bindings, kind):
    if type(kind) is not int or kind not in (0, 1):
        raise ValueError('kind must be 0 or 1')
    if not isinstance(bindings, dict) or set(bindings) != set(FIELDS):
        raise ValueError('bindings must contain exactly the N=11 verification-key coordinates')
    result = {}
    for name in FIELDS:
        row = bindings[name]
        if not isinstance(row, dict) or set(row) != {'int'}:
            raise ValueError('%s must contain one int field' % name)
        raw = row['int']
        if not isinstance(raw, str) or not raw or not raw.isascii() or not raw.isdecimal():
            raise ValueError('%s must be an unsigned decimal integer string' % name)
        value = int(raw)
        if not 0 <= value < P:
            raise ValueError('%s is outside the BN254 base field' % name)
        result[name] = str(value)
    return result


def generate(bindings, kind):
    v = checked(bindings, kind)
    pt = lambda p: '{ x: %s, y: %s }' % (v[p + '.x'], v[p + '.y'])
    g2 = lambda p: '{ xC1: %s, xC0: %s, yC1: %s, yC0: %s }' % tuple(v['%s.%s' % (p, f)] for f in ('xC1', 'xC0', 'yC1', 'yC0'))
    L = []
    a = L.append
    a('pragma arkade ^0.1.0;')
    a('struct Proof { int ax; int ay; int bxc1; int bxc0; int byc1; int byc0; int cx; int cy; }')
    a('struct Slot { Proof proof; int pub; int dep; int wd; bytes a; bytes d; }')
    a('contract RollupBatch() {')
    a('  function batch(Proof bp, Slot[%d] slots) {' % N)
    a('    require(this.activeInputIndex == 0);')
    a('    bytes newp = tx.packet(135);')
    a('    require(size(newp) == 64);')
    a('    bytes h = sha256(0x534802%02x%02x + substr(tx.inputs[0].packet(135), 0, 32) + newp);' % (kind, N))
    a('    int st = bin2num(substr(h, 0, 31) + 0x00);')
    a('    bytes seed = sha256(h + tx.inputs[0].arkadeWitnessHash);')
    a('    bool has = tx.numInputs > 1 && tx.inputs[1].scriptPubKey == tx.inputs[0].scriptPubKey && tx.inputs[1].witnessVersion == tx.inputs[0].witnessVersion;')
    a('    AssetId xid = tx.inputs[0].assets[0].assetId;')
    a('    int xin = 0;')
    a('    bytes f = "";')
    a('    int o_0 = 1;')
    a('    if (has) {')
    a('      AssetId rid = tx.inputs[1].assets[0].assetId;')
    a('      xid.txid = rid.txid;')
    a('      xid.gidx = rid.gidx;')
    a('      xin = tx.inputs[1].assets[0].amount;')
    a('      f = substr(sha256(xid.txid + substr(num2bin(xid.gidx + 65536, 3), 0, 2)), 0, 31) + 0x00;')
    a('      o_0 = 2;')
    a('    } else {')
    a('      require(true);')
    a('    }')
    for k in range(N):
        s = 'slots[%d]' % k
        p = '' if k == 0 else '_%d' % (k - 1)
        a('    int r%d = abs(bin2num(substr(sha256(seed + 0x%02x), 0, 16)));' % (k, k + 1))
        a('    ECPoint pa%d = { x: %s.proof.ax, y: %s.proof.ay };' % (k, s, s))
        a('    ECPoint ra%d = ecMul(pa%d, r%d, 2);' % (k, k, k))
        a('    ECPoint pc%d = { x: %s.proof.cx, y: %s.proof.cy };' % (k, s, s))
        a('    ECPoint ic%d = %s;' % (k, pt('batchIC.%d' % (k + 1))))
        if k == 0:
            a('    ECPoint sc_0 = ecMul(pc0, r0, 2);')
            a('    ECPoint bs_0 = ecMul(ic0, %s.pub, 2);' % s)
            a('    int s0_0 = %s.pub * r0;' % s)
            a('    int s1_0 = %s.dep * r0;' % s)
            a('    int s2_0 = %s.wd * r0;' % s)
            a('    int s3_0 = bin2num(%s.a) * r0;' % s)
            a('    int s4_0 = bin2num(%s.d) * r0;' % s)
            a('    int sr_0 = r0;')
        else:
            a('    ECPoint sc_%d = ecAdd(sc%s, ecMul(pc%d, r%d, 2), 2);' % (k, p, k, k))
            a('    ECPoint bs_%d = ecAdd(bs%s, ecMul(ic%d, %s.pub, 2), 2);' % (k, p, k, s))
            for j, e in enumerate(('%s.pub' % s, '%s.dep' % s, '%s.wd' % s, 'bin2num(%s.a)' % s, 'bin2num(%s.d)' % s)):
                a('    int s%d_%d = s%d%s + %s * r%d;' % (j, k, j, p, e, k))
            a('    int sr_%d = sr%s + r%d;' % (k, p, k))
        a('    bool ia%d = size(%s.a) != 0;' % (k, s))
        if k > 0:
            a('    require(!pend%s || (%s.wd != 0 && !ia%d));' % (p, s, k))
        a('    require(!ia%d || %s.a == f);' % (k, s))
        a('    require(%s.dep >= 0);' % s)
        a('    int net%d = %s.dep - %s.wd;' % (k, s, s))
        a('    int nall_%d = %snet%d;' % (k, '' if k == 0 else 'nall%s + ' % p, k))
        a('    int nbtc_%d = %snet%d * (1 - int(ia%d));' % (k, '' if k == 0 else 'nbtc%s + ' % p, k, k))
        a('    bool pend_%d = %s.wd != 0 && ia%d;' % (k, s, k))
        o = 'o_%d' % k
        a('    if (%s.wd != 0) {' % s)
        a('      require(tx.outputs[%s].witnessVersion == 1);' % o)
        a('      require(substr(sha256(tx.outputs[%s].scriptPubKey), 0, 31) + 0x00 == %s.d);' % (o, s))
        a('      if (ia%d) {' % k)
        a('        require(tx.outputs[%s].assets.lookup(xid.txid, xid.gidx) == %s.wd);' % (o, s))
        a('      } else {')
        a('        require(tx.outputs[%s].value == %s.wd);' % (o, s))
        a('      }')
        a('    } else {')
        a('      require(true);')
        a('    }')
        if k < N - 1:
            a('    int o_%d = %s + int(%s.wd != 0) * (1 - int(ia%d));' % (k + 1, o, s, k))
    last = '_%d' % (N - 1)
    a('    require(!pend%s);' % last)
    a('    ECPoint bpa = { x: bp.ax, y: bp.ay };')
    a('    ECPoint bpc = { x: bp.cx, y: bp.cy };')
    a('    ECPoint alpha = %s;' % pt('alpha'))
    a('    int q = %d;' % Q)
    a('    ECPoint ga = ecMul(alpha, (sr%s + 1) %% q, 2);' % last)
    terms = ['ecMul(cic%d, %s %% q, 2)' % (i, x) for i, x in enumerate(['sr' + last] + ['s%d%s' % (j, last) for j in range(5)])]
    for i in range(6):
        a('    ECPoint cic%d = %s;' % (i, pt('clientIC.%d' % i)))
    a('    ECPoint bic0 = %s;' % pt('batchIC.0'))
    a('    ECPoint bicst = %s;' % pt('batchIC.%d' % (N + 1)))
    expr = terms[0]
    for t in terms[1:] + ['bs' + last, 'bic0', 'ecMul(bicst, st, 2)']:
        expr = 'ecAdd(%s, %s, 2)' % (expr, t)
    a('    ECPoint lx = %s;' % expr)
    g1 = ['ra%d' % k for k in range(N)] + ['bpa', 'ga', 'lx', 'sc' + last, 'bpc']
    g2s = ['{ xC1: slots[%d].proof.bxc1, xC0: slots[%d].proof.bxc0, yC1: slots[%d].proof.byc1, yC0: slots[%d].proof.byc0 }' % (k, k, k, k) for k in range(N)]
    g2s += ['{ xC1: bp.bxc1, xC0: bp.bxc0, yC1: bp.byc1, yC0: bp.byc0 }', g2('negBeta'), g2('negGamma'), g2('negDeltaClient'), g2('negDeltaBatch')]
    a('    ECPoint[%d] g1 = [%s];' % (N + 5, ', '.join(g1)))
    a('    G2Point[%d] g2 = [%s];' % (N + 5, ', '.join(g2s)))
    a('    require(ecPairing(g1, g2, 2));')
    a('    require(tx.outputs[0].value == tx.inputs[0].value + nbtc%s);' % last)
    a('    if (has) {')
    a('      int kept = 0;')
    a('      if (tx.outputs[1].assets.has(xid.txid, xid.gidx)) {')
    a('        kept = tx.outputs[1].assets.lookup(xid.txid, xid.gidx);')
    a('      } else {')
    a('        require(true);')
    a('      }')
    a('      require(kept == xin + nall%s - nbtc%s);' % (last, last))
    a('    } else {')
    a('      require(true);')
    a('    }')
    a('    require(this.tunnel(0, { scriptPubKey: true, value: false, assets: true }));')
    a('  }')
    a('}')
    return '\n'.join(L) + '\n'


def main():
    parser = argparse.ArgumentParser(description='Generate the unrolled N=11 compiler batch variant.')
    parser.add_argument('bindings', type=Path)
    parser.add_argument('kind', type=int, choices=(0, 1))
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        with args.bindings.open(encoding='utf-8') as handle:
            source = generate(json.load(handle), args.kind)
        args.output.write_text(source, encoding='utf-8', newline='\n')
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
