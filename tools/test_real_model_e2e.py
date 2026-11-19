"""真实模型→本机正式HTTP/SSE/worker→隔离PG→实际iOS客户端。
只使用固定合成输入，不读取或重置已有账号；凭据和原始日志仅留0600临时目录。
"""
import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'outputs/real-model-e2e-review'
DEVICE = os.environ.get('MAOMAO_REVIEW_DEVICE', '5D171DD3-720E-4FC4-BEB5-BF7B73A25ECD')
APP = 'com.maomao.app'
RUN = 'real-' + uuid.uuid4().hex[:8]
TEMP = Path(tempfile.mkdtemp(prefix='maomao-' + RUN + '-'))
os.chmod(TEMP, 0o700)
DBNAME = 'maomao_memory_review_real_e2e_' + str(int(time.time()))
ENV = dict(os.environ)
ENV.pop('MAOMAO_DEEPSEEK_API_KEY', None)
ENV.update(MODEL_PROVIDER='deepseek', DATABASE_URL='postgres://maomao:maomao@127.0.0.1:5432/' + DBNAME,
           REVIEW_ACCOUNT_PATH=str(TEMP / 'accounts.json'))
REPORT = {'date': datetime.now(timezone.utc).isoformat(), 'run': RUN, 'database': DBNAME,
          'device': 'iPhone 17 Pro / iOS 26.5', 'provider': 'deepseek', 'appChecks': [], 'longConversation': [], 'temperaments': []}
PROCESSES = []
LOGS = []
BASE = ''
ACCOUNTS = {}
DOCUMENTS = None


def command(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, **kwargs)


def sim(*args):
    r = command(['xcrun', 'simctl', *args])
    if r.returncode:
        raise RuntimeError('模拟器命令未完成：' + args[0])
    return r.stdout.strip()


def stop_app():
    command(['xcrun', 'simctl', 'terminate', DEVICE, APP])


def until(read, label, seconds=65):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            value = read()
            if value:
                return value
        except (OSError, ValueError, IndexError, KeyError):
            pass
        time.sleep(.2)
    raise RuntimeError('等待超时：' + label)


def save():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / '链路与输出.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


def api(account, path, method='GET', body=None, raw=False, extra_headers=None):
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + account['token']}
    if extra_headers: headers.update(extra_headers)
    request = Request(BASE + '/v1/' + path, method=method, headers=headers,
                      data=None if body is None else json.dumps(body, ensure_ascii=False).encode())
    try:
        with urlopen(request, timeout=70) as response:
            data = response.read().decode()
    except HTTPError as error:
        raise RuntimeError('HTTP检查失败：' + str(error.code) + ' ' + path.split('?')[0]) from None
    return data if raw else json.loads(data)


def sql_json(query):
    r = command(['docker', 'exec', 'maomao-postgres-1', 'psql', '-U', 'maomao', '-d', DBNAME, '-tA', '-c', query])
    if r.returncode:
        raise RuntimeError('隔离库检查失败')
    return json.loads(r.stdout.strip())


def rounds(account):
    conv = str(uuid.UUID(account['conversationId']))
    return sql_json("select coalesce(json_agg(x order by x.created_at),'[]') from (select id,status,cat_message_id,error,memory_ids,diary_source_ids,context_source_ids,created_at from turns where conversation_id='" + conv + "') x")


def history(account):
    return sorted(api(account, 'messages?limit=100')['messages'], key=lambda m: m['seq'])


def snapshot(label, kind='history'):
    return json.loads((DOCUMENTS / f'{kind}-{RUN}-{label}.json').read_text())


def launch(account, script='', label='state', kind='history'):
    stop_app()
    repeated = ';'.join(f'{n}:{kind}Snapshot:{RUN}-{label}' for n in [1200, 2000, 3500, 6000, 10000, 16000, 25000, 38000, 53000])
    sim('launch', DEVICE, APP, '-backendMode', 'local', '-backendURL', BASE, '-backendToken', account['token'],
        '-script', '100:time:12;' + script + ';' + repeated)


def new_terminal(account, before):
    return until(lambda: next((t for t in rounds(account) if t['id'] not in before and t['status'] in ['completed', 'failed', 'stopped']), None), '真实回复终态')


def app_agrees(account, label):
    stored = history(account)
    def check():
        state = snapshot(label)
        return state if not state['waiting'] and not state['streaming'] and state['ids'] == [m['id'] for m in stored] and state['texts'] == [m['text'] for m in stored] else None
    return until(check, 'App与真实后端正文/消息身份对账')


def app_send(account, text, label, prefix=''):
    before = {r['id'] for r in rounds(account)}
    launch(account, prefix + '500:screen:chat;900:send:' + text, label)
    turn = new_terminal(account, before)
    if turn['status'] != 'completed':
        raise RuntimeError('真实App回复失败：' + (turn.get('error') or 'unknown').split(':')[0])
    app_agrees(account, label)
    reply = next(m['text'] for m in history(account) if m['id'] == turn['cat_message_id'])
    REPORT['appChecks'].append({'case': label, 'passed': True, 'turnId': turn['id'], 'input': text, 'reply': reply,
                                'memoryIds': turn['memory_ids'], 'diarySourceIds': turn['diary_source_ids'], 'sameTextAndIDs': True})
    save()
    print('App通过：' + label, flush=True)
    return turn, reply


def http_send(account, text):
    started = time.monotonic()
    stream = api(account, 'messages', 'POST', {'client_message_id': str(uuid.uuid4()), 'text': text}, raw=True)
    def parse(stream):
        event, data, event_id, events = '', [], '', []
        for line in (stream + '\n\n').splitlines():
            if line.startswith('event:'): event = line[6:].strip()
            elif line.startswith('id:'): event_id = line[3:].strip()
            elif line.startswith('data:'): data.append(line[5:].strip())
            elif line == '' and data:
                events.append((event, json.loads('\n'.join(data)), event_id)); event, data = '', []
        return events
    events = parse(stream)
    accepted = next((d for e, d, _ in events if e == 'accepted'), {})
    terminal = lambda rows: any(e in ['done','error','superseded'] for e, _, _ in rows)
    initial_complete = terminal(events)
    resumes = 0
    # 和App一样，流意外结束后对同一轮GET续传；不重发POST，不重跑模型。
    while not terminal(events) and accepted.get('turn_id') and resumes < 3:
        last_id = next((i for _, _, i in reversed(events) if i), '0')
        stream = api(account, 'turns/' + accepted['turn_id'] + '/stream', raw=True,
                     extra_headers={'Last-Event-ID':last_id,'x-maomao-snapshot':'1'})
        events.extend(parse(stream)); resumes += 1
    text_out = ''
    for e, d, _ in events:
        if e == 'delta': text_out += d['text']
        elif e == 'snapshot': text_out = d['text']
    error = next((d for e, d, _ in events if e == 'error'), None)
    done = next((d for e, d, _ in events if e == 'done'), None)
    return {'input': text, 'reply': text_out, 'turnId': accepted.get('turn_id'), 'completed': done is not None and error is None,
            'error': error, 'elapsedMs': round((time.monotonic() - started) * 1000),
            'initialStreamComplete':initial_complete,'streamResumes':resumes,'events':[e for e,_,_ in events]}


def start_process(args, name):
    log = open(TEMP / (name + '.log'), 'w'); os.chmod(log.name, 0o600); LOGS.append(log)
    p = subprocess.Popen(args, cwd=ROOT / 'server', env=ENV, stdout=log, stderr=log)
    PROCESSES.append(p)
    return p


def main():
    global BASE, ACCOUNTS, DOCUMENTS
    OUTPUT.mkdir(parents=True, exist_ok=True)
    cases_path = OUTPUT / '固定用例.json'
    cases = json.loads(cases_path.read_text())
    REPORT['casesSHA256'] = hashlib.sha256(cases_path.read_bytes()).hexdigest()
    sources = ['server/src/runtime/persona.ts', 'server/src/worker/memory.ts', 'server/src/worker/diary.ts', 'server/src/runtime/context.ts', 'server/src/runtime/yard.ts', 'server/src/turns/run.ts', 'ios/Maomao/Store/AppStore+Remote.swift']
    REPORT['sourceSHA256'] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sources}
    created = command(['docker', 'exec', 'maomao-postgres-1', 'createdb', '-U', 'maomao', DBNAME])
    if created.returncode: raise RuntimeError('创建隔离库失败')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); api_port = sock.getsockname()[1]
    ENV['PORT'] = str(api_port); BASE = f'http://127.0.0.1:{api_port}'
    migrated = command(['pnpm', 'db:migrate'], cwd=ROOT / 'server', env=ENV)
    if migrated.returncode: raise RuntimeError('隔离库迁移失败')
    seeded = command(['pnpm', 'exec', 'tsx', 'scripts/real-model-review-fixture.ts', 'seed'], cwd=ROOT / 'server', env=ENV)
    if seeded.returncode: raise RuntimeError('隔离账号准备失败')
    private = json.loads((TEMP / 'accounts.json').read_text()); ACCOUNTS = private.pop('accounts'); REPORT['configuration'] = private
    for name in ['ai', '@ai-sdk/deepseek']:
        REPORT.setdefault('packages', {})[name] = json.loads((ROOT / 'server/node_modules' / name / 'package.json').read_text())['version']
    start_process(['node', '--import', 'tsx', 'scripts/real-model-review-fixture.ts', 'serve'], 'api')
    start_process(['node', '--import', 'tsx', 'src/worker.ts'], 'worker')
    until(lambda: urlopen(BASE + '/healthz', timeout=2).status == 200, '隔离API启动', 20)
    app = ACCOUNTS['app']
    container = Path(sim('get_app_container', DEVICE, APP, 'data')); DOCUMENTS = container / 'Documents'
    print('真实API/worker与隔离PG就绪。', flush=True)
    # App实际发送、SSE接收、明确记忆保存与纠正。
    app_send(app, '记住，我不喝咖啡。', 'remember')
    mem = api(app, 'memories')['memories']; assert any('咖啡' in m['value'] for m in mem)
    app_send(app, '更正一下，我现在只喝无咖啡因咖啡。', 'correct')
    mem = api(app, 'memories')['memories']; assert any('无咖啡因' in m['value'] for m in mem)
    # 真实模型生成中强退重开，同一轮次恢复；不人为放慢模型。
    before = {r['id'] for r in rounds(app)}
    launch(app, '500:screen:chat;900:send:请认真帮我写一段约六百字的猫在草地散步的温柔小故事。', 'inflight')
    active = until(lambda: next((r for r in rounds(app) if r['id'] not in before and r['status'] == 'generating'), None), '观察真实生成中状态', 15)
    stop_app()
    launch(app, '500:screen:chat', 'restarted')
    terminal = until(lambda: next((r for r in rounds(app) if r['id'] == active['id'] and r['status'] in ['completed','failed']), None), '重开后回复完成')
    assert terminal['status'] == 'completed'
    app_agrees(app, 'restarted')
    assert len([r for r in rounds(app) if r['id'] not in before]) == 1
    REPORT['appChecks'].append({'case':'generation-restart','passed':True,'observedGenerating':True,'turnId':active['id'],'roundsCreated':1,'sameTextAndIDs':True}); save()
    print('App通过：真实生成中强退重开恢复。', flush=True)
    # 已关闭学习时仍由App真实发送，检查无新增及实际回复。
    setting = api(app, 'memory-settings')
    api(app, 'memory-settings', 'PATCH', {'learn':False,'revision':setting['revision']})
    before_mem = {m['id'] for m in api(app, 'memories')['memories']}
    app_send(app, '记住，我喜欢蓝色的松果盒。', 'learning-off')
    assert {m['id'] for m in api(app, 'memories')['memories']} == before_mem
    # 私密记录不得创建读取任务，更不能出现已读。
    private_text = '合成私密日记：我的测试收纳盒叫松果盒。'
    launch(app, '500:diaryCapture:' + private_text + ';800:diarySync;900:screen:mailbox', 'private', 'diary')
    row = until(lambda: next((r for r in api(app, 'diary')['entries'] if r['text'] == private_text),None), '私密日记同步')
    assert not row['cat_allowed'] and row['visit'] == 0 and not row['note']
    entry_id = str(uuid.UUID(row['id']))
    task_count = sql_json("select count(*) from async_jobs where kind='diary_read' and object_id='" + entry_id + "'")
    assert task_count == 0
    REPORT['appChecks'].append({'case':'private-diary','passed':True,'visit':0,'readJobs':0});save()
    # 主动开放的记录由常驻worker读取，回执真正回到App。
    shared = '合成日记：今天在窗边读硬科幻小说，书签图案是蓝鲸。'
    launch(app, '500:diaryCaptureShared:' + shared + ';800:diarySync;900:screen:mailbox', 'shared', 'diary')
    row = until(lambda: next((r for r in api(app, 'diary')['entries'] if r['text'] == shared and r['visit'] in [1,2]),None), '真实worker日记读取', 80)
    def shared_state():
        state = snapshot('shared', 'diary')
        i = state['texts'].index(shared)
        return state if state['visits'][i] in [1,2] and not state['needsSync'][i] else None
    until(shared_state, 'App收到真实读取回执')
    REPORT['appChecks'].append({'case':'worker-diary','passed':True,'entryId':row['id'],'visit':row['visit'],'note':row['note']});save()
    t, reply = app_send(app, '只根据这条日记说说，书签上画的是什么？', 'diary-chat', '400:diaryChat;')
    assert '蓝鲸' in reply and t['diary_source_ids'] == [row['id']]
    launch(app, '500:diaryShare:no;800:diarySync;900:screen:mailbox', 'revoked', 'diary')
    until(lambda: any(r['id']==row['id'] and not r['cat_allowed'] and r['visit']==0 and not r['note'] for r in api(app,'diary')['entries']), 'App撤回生效')
    until(lambda: snapshot('revoked','diary')['private'][-1] and not snapshot('revoked','diary')['needsSync'][-1], 'App收到撤回回执')
    derived = history(app)
    assert all(not m['context_allowed'] for m in derived if m.get('diary_entry_id') == row['id'] or m['id'] == t['cat_message_id'])
    REPORT['appChecks'].append({'case':'revoke-diary','passed':True,'entryId':row['id'],'derivedContextDisabled':True});save()
    # 从真实HTTP发固定30轮，超过当前30条消息上下文窗口。
    print('App链路检查完成；开始固定30轮连续对话。', flush=True)
    for case in cases['longConversation']:
        result = http_send(ACCOUNTS['long'], case['input']); result.update(id=case['id'], focus=case['focus'])
        if result.get('turnId'):
            current = next(r for r in rounds(ACCOUNTS['long']) if r['id']==result['turnId'])
            result.update(memoryIds=current['memory_ids'], contextSourceCount=len(current['context_source_ids'] or []))
        REPORT['longConversation'].append(result);save()
        if not result['completed']: print('连续对话出现失败轮次，证据已保留。',flush=True)
        if case['id'] % 5 == 0: print('连续对话已完成 '+str(case['id'])+'/30。',flush=True)
    for kind in ['slow','close','quiet','curious']:
        rows = [http_send(ACCOUNTS[kind], text) for text in cases['temperamentInputs']]
        REPORT['temperaments'].append({'temperament':kind,'familiarDays':8,'checks':rows});save()
        print('四气质采样：'+kind,flush=True)
    REPORT['modelUsage'] = sql_json("select coalesce(json_agg(x),'[]') from (select purpose,model,count(*) calls,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens from model_calls group by purpose,model) x")
    REPORT['collectionCompleted']=True
    REPORT['completed'] = all(c['passed'] for c in REPORT['appChecks']) and all(c['completed'] for c in REPORT['longConversation']) and all(c['completed'] for t in REPORT['temperaments'] for c in t['checks'])
    save()
    if not REPORT['completed']: raise RuntimeError('固定真实用例存在失败轮次，保留原样结果')
    print('真实链路与固定对话采样完成，表达质量需结合保留输出评判。',flush=True)


try:
    main()
except Exception as error:
    REPORT['completed']=False
    REPORT['failure']=str(error) if isinstance(error,(RuntimeError,AssertionError)) else type(error).__name__
    save()
    print('本轮验收未全部通过：'+(REPORT['failure'] or '断言失败，详见本机诊断'),flush=True)
    raise SystemExit(1)
finally:
    stop_app()
    for p in reversed(PROCESSES):
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=30)
            except subprocess.TimeoutExpired:p.kill();p.wait()
    for log in LOGS:log.close()
