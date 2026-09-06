"""Opt-in live pairing check on an isolated deployment. Creates/deletes a test member.
Usage: python3 scripts/check-browser-setup.py URL PROJECT /private/owner-login.json
The login file contains email/password. Credentials are never printed.
"""
import hashlib, http.cookiejar, json, secrets, sys, urllib.error, urllib.request
from pathlib import Path
base, project, login_path = sys.argv[1:]
base = base.rstrip('/')
owner = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
member = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
anon = urllib.request.build_opener()
def call(client, path, body=None, method=None, headers=None):
    h = {'Content-Type': 'application/json', **(headers or {})}
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
    try:
        r = client.open(req, timeout=35)
    except urllib.error.HTTPError as e:
        r = e
    raw = r.read()
    try: data = json.loads(raw)
    except ValueError: data = {'nonJson': True}
    return r.status, data
checks = []
def expect(name, actual, expected):
    assert actual == expected, f'{name}: expected {expected}, got {actual}'
    checks.append(name); print('PASS', name)
credentials = json.loads(Path(login_path).read_text())
expect('owner login', call(owner, '/api/auth/login', {k:credentials[k] for k in ('email','password')})[0], 200)
password = secrets.token_hex(20)
email = f'pairing-{secrets.token_hex(6)}@example.invalid'
status, user = call(owner, '/api/access/users', {'email': email, 'password':password, 'grants':[project]})
expect('temporary member created', status, 200)
uid = user['id']
try:
    expect('member login', call(member, '/api/auth/login', {'email': email, 'password':password})[0], 200)
    secret = secrets.token_hex(32)
    status, request = call(anon, '/api/auth/device', {'action':'start', 'project':project, 'machine':'Pairing security test', 'workspace':'security-fixture', 'challenge':hashlib.sha256(secret.encode()).hexdigest()})
    expect('start without device credentials', status, 200)
    ticket = request['ticket']; approve = {'action':'approve','ticket':ticket}
    expect('anonymous browser cannot approve', call(anon, '/api/auth/device', approve, headers={'Origin':base})[0], 401)
    expect('cross-origin browser cannot approve', call(member, '/api/auth/device', approve, headers={'Origin':'https://attacker.invalid'})[0], 403)
    expect('absent origin cannot approve', call(member, '/api/auth/device', approve)[0], 403)
    expect('wrong redemption secret rejected', call(anon, '/api/auth/device', {'action':'poll','ticket':ticket,'secret':'wrong'})[0], 400)
    expect('member approves', call(member, '/api/auth/device', approve, headers={'Origin':base})[0], 200)
    status, result = call(anon, '/api/auth/device', {'action':'poll','ticket':ticket,'secret':secret})
    expect('CLI redeems approval', status, 200)
    token = result['token']; auth = {'Authorization':'Bearer '+token}
    expect('ticket cannot be replayed', call(anon, '/api/auth/device', {'action':'poll','ticket':ticket,'secret':secret})[0], 400)
    endpoint = f'/api/connect/{project}/gateway/v1/connection'
    expect('project knowledge connection', call(anon, endpoint, headers=auth)[0], 200)
    expect('execution transport unavailable', call(anon, f'/api/connect/{project}/orchestrator/v1/agents/start', {}, headers=auth)[0], 404)
    expect('filesystem transport unavailable', call(anon, f'/api/connect/{project}/orchestrator/v1/fs/browse', headers=auth)[0], 404)
    expect('production local setup API disabled', call(member, f'/{project}/api/integrations', {'path':'/tmp/should-not-be-read'})[0], 403)
    expect('configuration acknowledgement', call(anon, '/api/auth/device', {'action':'complete','harnesses':['codex']}, headers=auth)[0], 200)
    status, listing = call(member, f'/{project}/api/integrations')
    expect('own workspace displayed', len(listing['workspaces']), 1)
    expect('server tools not reported as local', listing['detected'], [])
    expect('grant revoked', call(owner, '/api/access/users/'+uid, {'grants':[]}, method='PUT')[0], 200)
    expect('revoked grant blocks credential', call(anon, endpoint, headers=auth)[0], 401)
    expect('grant restored for token revocation test', call(owner, '/api/access/users/'+uid, {'grants':[project]}, method='PUT')[0], 200)
    expect('token revoked', call(member, '/api/tokens/'+token.split('_')[1], method='DELETE')[0], 200)
    expect('revoked token blocks credential', call(anon, endpoint, headers=auth)[0], 401)
finally:
    expect('temporary member removed', call(owner, '/api/access/users/'+uid, method='DELETE')[0], 200)
print(f'{len(checks)} live checks passed')
