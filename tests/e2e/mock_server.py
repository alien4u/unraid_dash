"""Stateful mock of the Unraid GraphQL API, seeded from tests/fixtures/mock.

Keys: "admin-key" (ADMIN), "viewer-key" (VIEWER, mutations FORBIDDEN), anything else UNAUTHENTICATED,
with the exact response shapes of the real server (HTTP 200, data null, extensions.code).

Tests drive the model in-process (MockServer methods); a separate process can use POST /_control
with {"cmd": "<method>", "args": {...}} and GET /_log.

Standalone: python3 -I tests/e2e/mock_server.py --port 8765 [--api-version 4.29.2]
"""

import argparse
import copy
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures' / 'mock'

ADMIN_KEY = 'admin-key'
VIEWER_KEY = 'viewer-key'
DEFAULT_API = '4.37.9+bedd403a'

# Operations whose fields are missing from the production schema below a version (validation error, HTTP 400)
MIN_VERSION = {
    'DockerWebUi': ((4, 30, 0), 'webUiUrl', 'DockerContainer'),
    'DockerUpdates': ((4, 30, 0), 'containerUpdateStatuses', 'Docker'),
    'DockerUpdateStatus': ((4, 30, 0), 'containerUpdateStatuses', 'Docker'),
    'DockerPause': ((4, 30, 0), 'pause', 'DockerMutations'),
    'DockerUnpause': ((4, 30, 0), 'unpause', 'DockerMutations'),
    'DockerUpdate': ((4, 30, 0), 'updateContainers', 'DockerMutations'),
    'DockerRestart': ((4, 36, 0), 'restart', 'DockerMutations'),
    'Temperature': ((4, 30, 0), 'temperature', 'Metrics'),
}

DOCKER_MUTATIONS = {
    'DockerStart': ('start', 'RUNNING', 'Up Less than a second'),
    'DockerStop': ('stop', 'EXITED', 'Exited (0) Less than a second ago'),
    'DockerPause': ('pause', 'PAUSED', 'Up 5 hours (Paused)'),
    'DockerUnpause': ('unpause', 'RUNNING', 'Up 5 hours'),
    'DockerRestart': ('restart', 'RUNNING', 'Up Less than a second'),
}

VM_MUTATIONS = {
    'VMStart': ('start', 'RUNNING'),
    'VMStop': ('stop', 'SHUTDOWN'),
    'VMResume': ('resume', 'RUNNING'),
    'VMReboot': ('reboot', 'RUNNING'),
}

# Provisional: built from unraid/api v4.37.9 parity-check-status.ts (speed is String(integer MB/s),
# errors/correcting are never set); not yet captured from a real server
PARITY_VARIANTS = {
    'running': {'status': 'RUNNING', 'progress': 42, 'speed': '187', 'errors': None, 'correcting': None,
                'date': '2026-10-31T22:00:00.000Z'},
    'running_errors': {'status': 'RUNNING', 'progress': 42, 'speed': '187', 'errors': 3, 'correcting': True,
                       'date': '2026-10-31T22:00:00.000Z'},
    'paused': {'status': 'PAUSED', 'progress': 42, 'speed': '0', 'errors': None, 'correcting': None,
               'date': '2026-10-31T22:00:00.000Z'},
    'completed_numeric': {'status': 'COMPLETED', 'progress': 0, 'speed': '0', 'errors': 0, 'correcting': None,
                          'date': '2026-10-06T15:19:08.000Z'},
    'completed_errors': {'status': 'COMPLETED', 'progress': 0, 'speed': '0', 'errors': 2, 'correcting': None,
                         'date': '2026-10-06T15:19:08.000Z'},
    'cancelled': {'status': 'CANCELLED', 'progress': 0, 'speed': '0', 'errors': None, 'correcting': None,
                  'date': '2026-10-06T15:19:08.000Z'},
    'failed': {'status': 'FAILED', 'progress': 0, 'speed': '0', 'errors': None, 'correcting': None,
               'date': '2026-10-06T15:19:08.000Z'},
    'never_run': {'status': 'NEVER_RUN', 'progress': 0, 'speed': '0', 'errors': None, 'correcting': None,
                  'date': None},
    'null': None,
}

TEMPERATURE_VARIANTS = {
    'plausible': {'summary': {'average': 38.4, 'warningCount': 1, 'criticalCount': 0,
                              'hottest': {'current': {'value': 56.6, 'unit': 'CELSIUS'}}}},
    'fahrenheit': {'summary': {'average': 101.2, 'warningCount': 0, 'criticalCount': 2,
                               'hottest': {'current': {'value': 133.9, 'unit': 'FAHRENHEIT'}}}},
    'kelvin': {'summary': {'average': 311.5, 'warningCount': 0, 'criticalCount': 0,
                           'hottest': {'current': {'value': 329.8, 'unit': 'KELVIN'}}}},
    'null': None,
}


def load_fixture(name):
    return json.loads((FIXTURES / f'{name}.json').read_text())


def fixture_data(name):
    return copy.deepcopy(load_fixture(name)['body']['data'])


def parse_version(text):
    match = re.match(r'(\d+)\.(\d+)\.(\d+)', text or '')
    return tuple(int(part) for part in match.groups()) if match else None


def set_path(node, path, value):
    keys = path.split('.')
    for key in keys[:-1]:
        node = node[int(key)] if isinstance(node, list) else node.setdefault(key, {})
    if isinstance(node, list):
        node[int(keys[-1])] = value
    else:
        node[keys[-1]] = value


class Drop(Exception):
    """Close the connection without a response."""


class Model:
    """Server state plus per-operation test controls."""

    def __init__(self):
        self.lock = threading.RLock()
        self.reset()

    def reset(self):
        with self.lock:
            self.api_version = DEFAULT_API
            self.down = False
            self.delays = {}
            self.failures = {}
            self.patches = {}
            self.log = []
            self.update_seconds = 2.0
            self.restart_seconds = 1.0
            self.vm_shutdown_polls = 2
            self.vm_result = True

            web_ui = {c['id']: c['webUiUrl'] for c in fixture_data('DockerWebUi')['docker']['containers']}
            updates = {u['name']: u['updateStatus']
                       for u in fixture_data('DockerUpdates')['docker']['containerUpdateStatuses']}
            self.containers = []
            for container in fixture_data('Docker')['docker']['containers']:
                name = container['names'][0].lstrip('/')
                container['webUiUrl'] = web_ui.get(container['id'])
                container['updateStatus'] = updates.get(name, 'UNKNOWN')
                container['updateDoneAt'] = None
                self.containers.append(container)

            self.vms = [dict(vm, shutdownPolls=None) for vm in fixture_data('VMs')['vms']['domains']]
            self.unread = list(fixture_data('NotificationListUnread')['notifications']['list'])
            self.archived = list(fixture_data('NotificationListArchive')['notifications']['list'])
            self.parity = fixture_data('ParityStatus')['array']['parityCheckStatus']
            self.temperature = fixture_data('Temperature')['metrics']['temperature']
            self.display = fixture_data('DiskTempThresholds')['info']['display']
            self.array = fixture_data('Array')['array']
            self.next_notification = 1

    # Test controls

    def configure(self, **fields):
        """Sets update_seconds, restart_seconds, vm_shutdown_polls (None = never SHUTOFF) or vm_result."""
        with self.lock:
            for name, value in fields.items():
                if name not in ('update_seconds', 'restart_seconds', 'vm_shutdown_polls', 'vm_result'):
                    raise KeyError(name)
                setattr(self, name, value)

    def set_api_version(self, version):
        with self.lock:
            self.api_version = version

    def set_down(self, down=True):
        with self.lock:
            self.down = down

    def delay(self, op, seconds, once=True):
        """Delays the response of an operation; a one-shot delay is used by the next request only."""
        with self.lock:
            entry = self.delays.setdefault(op, {'once': [], 'always': 0})
            if once:
                entry['once'].append(seconds)
            else:
                entry['always'] = seconds

    def fail(self, op, mode, message=None, once=False):
        """Fails an operation: http400, http500, http502, gql, gql_partial, unauth, drop or hang."""
        with self.lock:
            self.failures[op] = {'mode': mode, 'message': message, 'once': once}

    def clear_failures(self):
        with self.lock:
            self.failures = {}
            self.delays = {}

    def patch(self, op, path, value):
        """Overrides a value (dotted path under data) in every response of an operation."""
        with self.lock:
            self.patches.setdefault(op, []).append((path, value))

    def container(self, name):
        with self.lock:
            self._advance()
            return copy.deepcopy(self._container(name))

    def set_container(self, name, **fields):
        with self.lock:
            self._container(name).update(fields)

    def vm(self, name):
        with self.lock:
            return copy.deepcopy(next(v for v in self.vms if v['name'] == name))

    def set_vm(self, name, **fields):
        with self.lock:
            next(v for v in self.vms if v['name'] == name).update(fields)

    def set_disk(self, name, **fields):
        with self.lock:
            for group in ('parities', 'disks', 'caches'):
                for disk in self.array[group]:
                    if disk['name'] == name:
                        disk.update(fields)
                        return
            raise KeyError(name)

    def set_array_state(self, state):
        with self.lock:
            self.array['state'] = state

    def set_parity(self, variant):
        with self.lock:
            if variant == 'completed':
                self.parity = fixture_data('ParityStatus')['array']['parityCheckStatus']
            else:
                self.parity = copy.deepcopy(PARITY_VARIANTS[variant])

    def set_temperature(self, variant):
        with self.lock:
            if variant == 'real':
                self.temperature = fixture_data('Temperature')['metrics']['temperature']
            else:
                self.temperature = copy.deepcopy(TEMPERATURE_VARIANTS[variant])

    def set_display(self, display):
        with self.lock:
            self.display = display

    def add_notification(self, importance='WARNING', title=None, subject='Mock subject'):
        with self.lock:
            number = self.next_notification
            self.next_notification += 1
            item = {
                'id': f'mock:Unraid_Mock_{number}.notify',
                'title': title or f'Mock notification {number}',
                'subject': subject,
                'importance': importance,
                'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
            }
            self.unread.insert(0, item)
            return item

    def update_notification(self, notification_id, **fields):
        with self.lock:
            next(n for n in self.unread if n['id'] == notification_id).update(fields)

    def mark(self):
        with self.lock:
            return len(self.log)

    def ops(self, since=0):
        with self.lock:
            return [entry['op'] for entry in self.log[since:]]

    def requests(self, since=0):
        with self.lock:
            return copy.deepcopy(self.log[since:])

    # Request handling

    def _container(self, name):
        for container in self.containers:
            if container['names'][0].lstrip('/') == name:
                return container
        raise KeyError(name)

    def _advance(self):
        now = time.monotonic()
        for container in self.containers:
            if container['updateDoneAt'] is not None and now >= container['updateDoneAt']:
                container['updateDoneAt'] = None
                container['updateStatus'] = 'UP_TO_DATE'
                if container['state'] == 'RUNNING':
                    container['status'] = 'Up Less than a second'

    def _unread_overview(self):
        counts = {'info': 0, 'warning': 0, 'alert': 0}
        for item in self.unread:
            counts[item['importance'].lower()] += 1
        counts['total'] = len(self.unread)
        return counts

    def handle(self, op, kind, variables, key):
        """Returns (status, body, delay_seconds) or raises Drop."""
        with self.lock:
            role = {ADMIN_KEY: 'ADMIN', VIEWER_KEY: 'VIEWER'}.get(key)
            self.log.append({'op': op, 'kind': kind, 'role': role, 'variables': variables, 't': time.time()})
            self._advance()

            entry = self.delays.get(op)
            delay = entry['once'].pop(0) if entry and entry['once'] else (entry['always'] if entry else 0)

            if self.down:
                return None, None, delay

            failure = self.failures.get(op)
            if failure and failure['once']:
                del self.failures[op]

            if role is None:
                return 200, load_fixture('Auth_invalid')['body'], delay

            gate = MIN_VERSION.get(op)
            version = parse_version(self.api_version)
            if gate and (version is None or version < gate[0]):
                return 400, self._validation_error(gate[1], gate[2]), delay

            if failure:
                return self._failure(op, failure) + (delay,)

            if kind == 'mutation' and role == 'VIEWER':
                body = copy.deepcopy(load_fixture('Mutation_viewer_forbidden')['body'])
                body['errors'][0]['path'] = self._mutation_path(op)
                return 200, body, delay

            builder = getattr(self, '_op_' + op, None)
            if builder is None:
                return 400, self._validation_error(op, 'Query'), delay

            data = builder(variables or {}, role)
            if data is None:
                return 200, {'errors': [{'message': 'Not found', 'extensions': {'code': 'NOT_FOUND'}}],
                             'data': None}, delay
            if isinstance(data, tuple):
                data, delay = data[0], max(delay, data[1])
            for path, value in self.patches.get(op, []):
                set_path(data, path, value)
            return 200, {'data': data}, delay

    @staticmethod
    def _validation_error(field, type_name):
        body = copy.deepcopy(load_fixture('Validation_error')['body'])
        body['errors'][0]['message'] = f'Cannot query field "{field}" on type "{type_name}".'
        return body

    @staticmethod
    def _mutation_path(op):
        if op in DOCKER_MUTATIONS:
            return ['docker', DOCKER_MUTATIONS[op][0]]
        if op in VM_MUTATIONS:
            return ['vm', VM_MUTATIONS[op][0]]
        return {'DockerUpdate': ['docker', 'updateContainers'], 'ArchiveNotification': ['archiveNotification'],
                'ArchiveAll': ['archiveAll']}.get(op, [op])

    def _failure(self, op, failure):
        mode = failure['mode']
        message = failure['message']
        if mode == 'drop':
            raise Drop()
        if mode == 'hang':
            return 'hang', None
        if mode == 'unauth':
            return 200, load_fixture('Auth_invalid')['body']
        if mode == 'http400':
            return 400, self._validation_error(message or 'mockField', 'Query')
        if mode.startswith('http'):
            return int(mode[4:]), '<html><body>Bad Gateway</body></html>'
        error = {'message': message or 'Mock server error', 'extensions': {'code': 'INTERNAL_SERVER_ERROR'}}
        if mode == 'gql_partial':
            return 200, {'errors': [dict(error, path=self._mutation_path(op))],
                         'data': {self._mutation_path(op)[0]: None}}
        return 200, {'errors': [error], 'data': None}

    def _op_Core(self, variables, role):
        data = fixture_data('Core_viewer' if role == 'VIEWER' else 'Core')
        data['notifications']['overview']['unread'] = self._unread_overview()
        return data

    def _op_TestConnection(self, variables, role):
        return fixture_data('TestConnection')

    def _op_Me(self, variables, role):
        return fixture_data('Me_viewer' if role == 'VIEWER' else 'Me')

    def _op_ApiVersion(self, variables, role):
        return {'info': {'versions': {'core': {'api': self.api_version}}}}

    def _op_Array(self, variables, role):
        return {'array': copy.deepcopy(self.array)}

    def _op_Network(self, variables, role):
        return fixture_data('Network')

    def _containers(self, fields):
        return [{field: copy.deepcopy(c[field]) for field in fields} for c in self.containers]

    def _update_statuses(self):
        return [{'name': c['names'][0].lstrip('/'), 'updateStatus': c['updateStatus']} for c in self.containers]

    def _op_Docker(self, variables, role):
        return {'docker': {'containers': self._containers(['id', 'names', 'state', 'status', 'autoStart', 'ports'])}}

    def _op_DockerBasic(self, variables, role):
        return {'docker': {'containers': self._containers(['id', 'names', 'state', 'status', 'autoStart'])}}

    def _op_DockerWebUi(self, variables, role):
        return {'docker': {'containers': self._containers(['id', 'webUiUrl'])}}

    def _op_DockerUpdates(self, variables, role):
        return {'docker': {'containerUpdateStatuses': self._update_statuses()}}

    def _op_DockerStatus(self, variables, role):
        return {'docker': {'containers': self._containers(['id', 'names', 'state'])}}

    def _op_DockerUpdateStatus(self, variables, role):
        return {'docker': {'containers': self._containers(['id', 'names', 'state']),
                           'containerUpdateStatuses': self._update_statuses()}}

    def _op_VMs(self, variables, role):
        return {'vms': {'domains': [{'id': v['id'], 'name': v['name'], 'state': v['state']} for v in self.vms]}}

    def _op_VMStatus(self, variables, role):
        for vm in self.vms:
            if vm['state'] == 'SHUTDOWN' and vm['shutdownPolls'] is not None:
                if vm['shutdownPolls'] <= 0:
                    vm['state'] = 'SHUTOFF'
                    vm['shutdownPolls'] = None
                else:
                    vm['shutdownPolls'] -= 1
        return {'vms': {'domains': [{'id': v['id'], 'state': v['state']} for v in self.vms]}}

    def _op_ParityStatus(self, variables, role):
        return {'array': {'parityCheckStatus': copy.deepcopy(self.parity)}}

    def _op_DiskTempThresholds(self, variables, role):
        return {'info': {'display': copy.deepcopy(self.display)}}

    def _op_Temperature(self, variables, role):
        return {'metrics': {'temperature': copy.deepcopy(self.temperature)}}

    def _op_BadgeCount(self, variables, role):
        return {'notifications': {'overview': {'unread': {'total': len(self.unread)}}}}

    def _op_NotificationList(self, variables, role):
        query = variables.get('filter') or {}
        source = self.archived if query.get('type') == 'ARCHIVE' else self.unread
        offset = query.get('offset', 0)
        return {'notifications': {'list': copy.deepcopy(source[offset:offset + query.get('limit', 50)])}}

    def _docker_mutation(self, op, variables):
        field, state, status = DOCKER_MUTATIONS[op]
        container = next((c for c in self.containers if c['id'] == variables.get('id')), None)
        if container is None:
            return None
        container['state'] = state
        container['status'] = status
        result = {'docker': {field: {'id': container['id'], 'state': state, 'status': status}}}
        return (result, self.restart_seconds) if op == 'DockerRestart' else result

    def _op_DockerStart(self, variables, role):
        return self._docker_mutation('DockerStart', variables)

    def _op_DockerStop(self, variables, role):
        return self._docker_mutation('DockerStop', variables)

    def _op_DockerPause(self, variables, role):
        return self._docker_mutation('DockerPause', variables)

    def _op_DockerUnpause(self, variables, role):
        return self._docker_mutation('DockerUnpause', variables)

    def _op_DockerRestart(self, variables, role):
        return self._docker_mutation('DockerRestart', variables)

    def _op_DockerUpdate(self, variables, role):
        done_at = time.monotonic() + self.update_seconds
        updated = []
        for container in self.containers:
            if container['id'] in (variables.get('ids') or []):
                container['updateDoneAt'] = done_at
                updated.append({'id': container['id'], 'state': container['state']})
        return {'docker': {'updateContainers': updated}}, self.update_seconds

    def _vm_mutation(self, op, variables):
        field, state = VM_MUTATIONS[op]
        vm = next((v for v in self.vms if v['id'] == variables.get('id')), None)
        if vm is None:
            return None
        if self.vm_result:
            vm['state'] = state
            vm['shutdownPolls'] = self.vm_shutdown_polls if op == 'VMStop' else None
        result = {'vm': {field: self.vm_result}}
        return (result, self.restart_seconds) if op == 'VMReboot' else result

    def _op_VMStart(self, variables, role):
        return self._vm_mutation('VMStart', variables)

    def _op_VMStop(self, variables, role):
        return self._vm_mutation('VMStop', variables)

    def _op_VMResume(self, variables, role):
        return self._vm_mutation('VMResume', variables)

    def _op_VMReboot(self, variables, role):
        return self._vm_mutation('VMReboot', variables)

    def _op_ArchiveNotification(self, variables, role):
        item = next((n for n in self.unread if n['id'] == variables.get('id')), None)
        if item:
            self.unread.remove(item)
            self.archived.insert(0, item)
        return {'archiveNotification': {'id': variables.get('id')}}

    def _op_ArchiveAll(self, variables, role):
        self.archived[:0] = self.unread
        self.unread = []
        return {'archiveAll': {'unread': {'total': 0}}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _send(self, status, body):
        payload = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html' if isinstance(body, str) else 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _drop(self):
        self.close_connection = True
        try:
            self.connection.shutdown(2)
        except OSError:
            pass

    def do_GET(self):
        if self.path == '/_log':
            self._send(200, self.server.model.requests())
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        model = self.server.model
        length = int(self.headers.get('Content-Length') or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            self._send(400, {'errors': [{'message': 'Invalid JSON'}]})
            return

        if self.path == '/_control':
            method = getattr(model, payload.get('cmd', ''), None)
            if payload.get('cmd', '').startswith('_') or not callable(method):
                self._send(400, {'error': 'unknown command'})
                return
            self._send(200, {'result': method(**payload.get('args', {}))})
            return

        if self.path.rstrip('/') != '/graphql':
            self._send(404, {'error': 'not found'})
            return

        match = re.match(r'\s*(query|mutation)\s+(\w+)', payload.get('query') or '')
        kind, op = match.groups() if match else ('query', 'Anonymous')
        try:
            status, body, delay = model.handle(op, kind, payload.get('variables'), self.headers.get('x-api-key'))
        except Drop:
            self._drop()
            return

        if delay:
            time.sleep(delay)
        if status is None:
            self._drop()
            return
        if status == 'hang':
            time.sleep(30)
            self._drop()
            return
        self._send(status, body)


class MockServer:
    """Runs the mock on 127.0.0.1 in a background thread."""

    def __init__(self, port=0):
        self.model = Model()
        self.httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.httpd.daemon_threads = True
        self.httpd.model = self.model
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self):
        return self.httpd.server_address[1]

    @property
    def url(self):
        return f'http://127.0.0.1:{self.port}'

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def __getattr__(self, name):
        return getattr(self.model, name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--api-version', default=DEFAULT_API)
    args = parser.parse_args()
    server = MockServer(args.port)
    server.model.set_api_version(args.api_version)
    print(f'Mock Unraid API on {server.url}/graphql (keys: {ADMIN_KEY}, {VIEWER_KEY})')
    try:
        server.httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
