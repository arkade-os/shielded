import argparse
from collections import Counter
import json
from pathlib import Path
import re


WATCHED = ('OP_NIP', 'OP_PICK', 'OP_ROLL', 'OP_PUT', 'OP_ECMUL', 'OP_ECPAIRING')
NUMERIC_PUSHES = {'OP_%d' % i for i in range(17)} | {'OP_1NEGATE', 'OP_FALSE', 'OP_TRUE'}
UNIT = 'assembly tokens (not script bytes or weight units)'


def summarize(artifact):
    if not isinstance(artifact, dict) or not isinstance(artifact.get('functions'), list):
        raise ValueError('artifact must contain a functions array')
    functions, names = {}, set()
    for function in artifact['functions']:
        if not isinstance(function, dict):
            raise ValueError('each function must be an object')
        name = function.get('name')
        if not isinstance(name, str) or not name or name in names:
            raise ValueError('function names must be nonempty and unique')
        names.add(name)
        if 'arkade' not in function:
            continue
        target = function['arkade']
        if not isinstance(target, dict) or not isinstance(target.get('asm'), list):
            raise ValueError('%s must contain an arkade.asm array' % name)
        opcodes = Counter({opcode: 0 for opcode in WATCHED})
        pushes, wide = 0, 0
        for token in target['asm']:
            if not isinstance(token, str):
                raise ValueError('%s has a non-string assembly token' % name)
            if re.fullmatch(r'OP_[A-Z0-9_]+', token):
                opcodes[token] += 1
                pushes += token in NUMERIC_PUSHES
            elif re.fullmatch(r'-?[0-9]+', token):
                pushes += 1
                wide += not -(1 << 63) <= int(token) < (1 << 63)
            elif re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*|<[A-Za-z_][A-Za-z0-9_.]*>', token):
                pushes += 1
            else:
                raise ValueError('%s has a malformed assembly token: %r' % (name, token))
        functions[name] = {
            'asmTokens': len(target['asm']), 'pushTokens': pushes,
            'wideIntegerPushes': wide, 'opcodes': dict(sorted(opcodes.items())),
        }
    return {'functions': dict(sorted(functions.items()))}


def compare(old, new):
    delta = {}
    empty = {'asmTokens': 0, 'pushTokens': 0, 'wideIntegerPushes': 0, 'opcodes': {}}
    for name in sorted(old['functions'].keys() | new['functions'].keys()):
        before, after = old['functions'].get(name, empty), new['functions'].get(name, empty)
        row = {key: after[key] - before[key] for key in ('asmTokens', 'pushTokens', 'wideIntegerPushes')}
        row['opcodes'] = {
            opcode: after['opcodes'].get(opcode, 0) - before['opcodes'].get(opcode, 0)
            for opcode in sorted(before['opcodes'].keys() | after['opcodes'].keys())
        }
        delta[name] = row
    return {'functions': delta}


def main():
    parser = argparse.ArgumentParser(description='Count compiler assembly tokens; opcode semantics are checked by the Go VM harness.')
    parser.add_argument('old', type=Path)
    parser.add_argument('new', type=Path, nargs='?')
    args = parser.parse_args()
    try:
        with args.old.open(encoding='utf-8') as handle:
            old = summarize(json.load(handle))
        result = {'unit': UNIT, 'old': old}
        if args.new:
            with args.new.open(encoding='utf-8') as handle:
                new = summarize(json.load(handle))
            result.update(new=new, delta=compare(old, new))
        print(json.dumps(result, indent=2, sort_keys=True))
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
