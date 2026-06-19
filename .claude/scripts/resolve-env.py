#!/usr/bin/env python3
# t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
"""4-tier env variable resolver: runtime > skill > shared > global."""
import os, sys, argparse
from pathlib import Path

def resolve(var, skill=None):
    """Resolve env var through 4-tier hierarchy."""
    # Tier 1: Runtime
    val = os.environ.get(var)
    if val: return val, 'runtime'

    # Tier 2: Skill-specific
    if skill:
        skill_env = Path('.claude/skills') / skill / '.env'
        val = _read_env_file(skill_env, var)
        if val: return val, f'skill ({skill})'

    # Tier 3: Shared
    shared_env = Path('.claude/.env.shared')
    val = _read_env_file(shared_env, var)
    if val: return val, 'shared'

    # Tier 4: Global
    global_env = Path.home() / '.claude' / '.env'
    val = _read_env_file(global_env, var)
    if val: return val, 'global'

    return None, 'not found'

def _read_env_file(path, var):
    """Read a var from a .env file."""
    if not path.exists(): return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1)
        if k.strip() == var: return v.strip().strip('"').strip("'")
    return None

def show_hierarchy(var, skill=None):
    """Show all tiers with resolved values."""
    tiers = [
        ('Runtime (env)', os.environ.get(var)),
        (f'Skill ({skill})' if skill else 'Skill (none)',
         _read_env_file(Path('.claude/skills') / skill / '.env', var) if skill else None),
        ('Shared (.claude/.env.shared)', _read_env_file(Path('.claude/.env.shared'), var)),
        ('Global (~/.claude/.env)', _read_env_file(Path.home() / '.claude' / '.env', var)),
    ]
    for name, val in tiers:
        masked = val[:3] + '***' if val and len(val) > 3 else val
        status = f'= {masked}' if val else '(empty)'
        print(f'  {name}: {status}')

if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Resolve env vars through 4-tier hierarchy')
    p.add_argument('--var', required=True, help='Variable name')
    p.add_argument('--skill', help='Skill name for tier-2 context')
    p.add_argument('--show-hierarchy', action='store_true', help='Show all tiers')
    args = p.parse_args()

    if args.show_hierarchy:
        print(f'Hierarchy for {args.var}:')
        show_hierarchy(args.var, args.skill)

    val, tier = resolve(args.var, args.skill)
    if val:
        print(val)
    else:
        sys.exit(1)
