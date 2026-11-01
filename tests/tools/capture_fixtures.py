"""Record real Unraid API responses for every read query in js/background.js.

Raw responses go to tests/fixtures/real/ (gitignored, contains server data).
A scrubbed copy goes to tests/fixtures/mock/ for the committed mock server.

Usage: python3 -I tests/tools/capture_fixtures.py [--env ~/.config/unraid-dash-test/.env]
"""

import argparse
import hashlib
import ipaddress
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REAL_DIR = ROOT / 'tests' / 'fixtures' / 'real'
MOCK_DIR = ROOT / 'tests' / 'fixtures' / 'mock'

VARIABLES = {
    'NotificationList': [
        ('Unread', {'filter': {'type': 'UNREAD', 'offset': 0, 'limit': 50}}),
        ('Archive', {'filter': {'type': 'ARCHIVE', 'offset': 0, 'limit': 20}}),
    ],
}


def load_env(path):
    env = {}
    for line in Path(path).expanduser().read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip()
    return env


def read_queries():
    source = (ROOT / 'js' / 'background.js').read_text()
    queries = {}
    for match in re.finditer(r'const QUERY_\w+ = `([\s\S]*?)`;', source):
        text = match.group(1)
        op = re.search(r'query\s+(\w+)', text)
        if op:
            queries[op.group(1)] = text
    return queries


def make_client(env):
    url = env['UNRAID_URL'].rstrip('/') + '/graphql'
    ca_file = env.get('UNRAID_CA_FILE')
    context = ssl.create_default_context(cafile=str(Path(ca_file).expanduser())) if ca_file else None

    def call(key, query, variables=None):
        body = {'query': query}
        if variables:
            body['variables'] = variables
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
            'Content-Type': 'application/json',
            'x-api-key': key,
        })
        try:
            with urllib.request.urlopen(request, timeout=30, context=context) as response:
                return {'status': response.status, 'body': json.loads(response.read())}
        except urllib.error.HTTPError as err:
            raw = err.read().decode(errors='replace')
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = raw[:2000]
            return {'status': err.code, 'body': parsed}

    return call


class Scrubber:
    """Replaces server-identifying values with stable placeholders."""

    def __init__(self, env):
        self.host = re.sub(r'^https?://', '', env['UNRAID_URL']).split('/')[0].split(':')[0]
        self.domain = self.host.split('.', 1)[1] if '.' in self.host else None
        self.ips = {}
        self.serials = {}
        self.vm_names = {}
        self.container_names = {}
        self.server_names = set()

    def ip(self, value):
        if value not in self.ips:
            self.ips[value] = f'192.0.2.{len(self.ips) + 10}'
        return self.ips[value]

    @staticmethod
    def hex_id(value):
        return hashlib.sha256(('unraid-dash-fixture:' + value).encode()).hexdigest()[:len(value)]

    def uuid(self, value):
        digest = self.hex_id(value.replace('-', ''))
        return f'{digest[:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:32]}'

    def id_part(self, part):
        if re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}', part):
            return self.uuid(part)
        if re.fullmatch(r'[0-9a-fA-F]+', part):
            return self.hex_id(part)
        if re.fullmatch(r'[A-Za-z]+_[A-Za-z_]*\d+\.notify', part) or part in ('disk', 'sha256'):
            return part
        return 'x' + self.hex_id(part)[:10]

    def container(self, name):
        bare = name.lstrip('/')
        self.container_names.setdefault(bare, f'app-{len(self.container_names) + 1:02d}')
        return name[:len(name) - len(bare)] + self.container_names[bare]

    def string(self, value, key):
        if key in ('id', 'imageId'):
            if value.startswith('disk:'):
                serial = value[5:]
                self.serials.setdefault(serial, f'SERIAL{len(self.serials) + 1:02d}')
                return 'disk:' + self.serials[serial]
            return ':'.join(self.id_part(p) for p in value.split(':'))
        if value in self.server_names:
            return 'Tower'
        for raw in re.findall(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', value):
            address = ipaddress.ip_address(raw)
            if address.is_private or address in ipaddress.ip_network('100.64.0.0/10'):
                value = value.replace(raw, self.ip(raw))
        value = re.sub(r'\b\d{1,3}(?:-\d{1,3}){3}\.[0-9a-f]{40}\.myunraid\.net',
                       '192-0-2-10.0000000000000000000000000000000000000000.myunraid.net', value)
        value = re.sub(r'[\w-]+\.[\w-]+\.ts\.net', 'tower.example.ts.net', value)
        if self.host:
            value = value.replace(self.host, 'tower.example.lan')
        if self.domain:
            value = value.replace(self.domain, 'example.lan')
        for real, fake in self.container_names.items():
            value = re.sub(rf'\b{re.escape(real)}\b', fake, value) if key == 'webUiUrl' else value
        return value

    def walk(self, node, key=None, parent=None):
        if isinstance(node, dict):
            if 'state' in node and 'name' in node and parent == 'domains':
                name = node['name']
                self.vm_names.setdefault(name, f'vm-{len(self.vm_names) + 1}')
            return {k: self.walk(v, k, key) for k, v in node.items()}
        if isinstance(node, list):
            return [self.walk(item, key, key) for item in node]
        if isinstance(node, str):
            if parent == 'domains' and key == 'name':
                return self.vm_names.get(node, node)
            if key == 'names' or (key == 'name' and parent == 'containerUpdateStatuses'):
                return self.container(node)
            if key == 'hostname':
                return 'tower'
            if key in ('title', 'subject', 'description') and parent == 'list':
                return f'Test {key}'
            return self.string(node, key)
        return node


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--env', default='~/.config/unraid-dash-test/.env')
    args = parser.parse_args()

    env = load_env(args.env)
    call = make_client(env)
    queries = read_queries()
    REAL_DIR.mkdir(parents=True, exist_ok=True)
    MOCK_DIR.mkdir(parents=True, exist_ok=True)

    captures = {}
    for op, query in queries.items():
        for suffix, variables in VARIABLES.get(op, [('', None)]):
            captures[op + suffix] = call(env['UNRAID_ADMIN_KEY'], query, variables)
    captures['Me_viewer'] = call(env['UNRAID_VIEWER_KEY'], queries['Me'])
    captures['Core_viewer'] = call(env['UNRAID_VIEWER_KEY'], queries['Core'])
    captures['Docker_viewer'] = call(env['UNRAID_VIEWER_KEY'], queries['Docker'])
    captures['Auth_invalid'] = call('0' * 64, queries['TestConnection'])
    captures['Validation_error'] = call(env['UNRAID_ADMIN_KEY'], 'query Bogus { array { notAField } }')

    core = captures.get('Core', {}).get('body', {}).get('data') or {}
    scrubber = Scrubber(env)
    if (core.get('vars') or {}).get('name'):
        scrubber.server_names.add(core['vars']['name'])

    meta = {
        'captured_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'unraid': env.get('UNRAID_VERSION'),
        'api': ((captures.get('ApiVersion', {}).get('body', {}).get('data') or {}).get('info') or {}).get('versions'),
    }

    for name, result in captures.items():
        (REAL_DIR / f'{name}.json').write_text(json.dumps(result, indent=2) + '\n')
        (MOCK_DIR / f'{name}.json').write_text(json.dumps(scrubber.walk(result), indent=2) + '\n')
    (REAL_DIR / '_meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    (MOCK_DIR / '_meta.json').write_text(json.dumps(scrubber.walk(meta), indent=2) + '\n')

    for name, result in sorted(captures.items()):
        body = result['body']
        errors = body.get('errors') if isinstance(body, dict) else None
        note = f" errors: {errors[0].get('message', '')[:90]}" if errors else ''
        print(f"{result['status']}  {name}{note}")
    print(f'{len(captures)} captures -> {REAL_DIR.relative_to(ROOT)} and {MOCK_DIR.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
