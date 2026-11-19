"""真实模拟器客户端的重启恢复契约测试；隔离 HTTP/SSE，不代替 PG 集成测试。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json, subprocess, threading, time, uuid

scenario = {}
def sim(*args):
    return subprocess.check_output(['xcrun', 'simctl', *args], text=True).strip()
def stop():
    subprocess.run(['xcrun','simctl','terminate','booted','com.maomao.app'], capture_output=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def stream(self, first=False):
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        def event(kind, data, index):
            self.wfile.write(f'id: db-{index}\nevent: {kind}\ndata: {json.dumps(data)}\n\n'.encode()); self.wfile.flush()
        try:
            if first and scenario['name'] in ['unaccepted','unacceptedReply']:
                time.sleep(8); return
            event('accepted', {'turn_id':'turn-1','user_message_id':'user-1'},0)
            if first:
                event('delta', {'text':'半截'},1)
                time.sleep(8); return
            event('snapshot', {'text':'完整回复'},1)
            event('done', {'message_id':'cat-1','status':'stopped' if scenario['name']=='stopped' else 'done'},2)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_POST(self):
        if self.path in ['/v1/messages','/v1/messages/user-1/reply']:
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            scenario['sends'].append(body.get('client_message_id',body.get('request_id')))
            scenario['client_id']=body.get('client_message_id','fixture-user')
            self.stream(first=not scenario['restarted'])
        else:
            self.send_response(404); self.end_headers()
    def do_GET(self):
        if self.path.startswith('/v1/messages'):
            rows=[]
            if scenario['restarted'] or scenario['name']=='unacceptedReply':
                rows=[dict(id='user-1',seq=1,role='user',text='恢复验证',status='done',client_message_id=scenario['client_id'],remembered=False,boundary=False)]
                if scenario['name']=='completed':
                    rows.append(dict(id='cat-1',seq=2,role='cat',text='完整回复',status='done',remembered=False,boundary=False))
            self.json({'messages':rows})
        elif self.path == '/v1/turns/turn-1/stream':
            scenario['resumes']+=1; self.stream()
        elif self.path == '/v1/turns/turn-1':
            status={'completed':'completed','stopped':'stopped','failed':'failed','superseded':'superseded'}.get(scenario['name'],'generating')
            self.json(dict(id='turn-1',status=status,cat_message_id='cat-1' if status in ['completed','stopped'] else None,extracted=True,remembered=False))
        elif self.path == '/v1/memories': self.json({'memories':[]})
        elif self.path == '/v1/boundaries': self.json({'boundaries':[]})
        else:
            self.send_response(404); self.end_headers()

def launch(script, token):
    sim('launch','booted','com.maomao.app','-backendMode','local','-backendURL','http://127.0.0.1:18788','-backendToken',token,'-script',script)
def snapshot(name, since):
    docs=Path(sim('get_app_container','booted','com.maomao.app','data'))/'Documents'
    path=docs/f'history-{name}.json'
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        if path.exists() and path.stat().st_mtime>=since: return json.loads(path.read_text())
        time.sleep(.2)
    raise AssertionError(f'未收到 {name} 快照')
server=ThreadingHTTPServer(('127.0.0.1',18788),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    for name in ['streaming','completed','unaccepted','stopped','failed','superseded','unacceptedReply']:
        stop()
        scenario={'name':name,'sends':[],'resumes':0,'restarted':False,'client_id':'fixture-user'}
        token='isolated-recovery-'+str(uuid.uuid4())
        command='recoveryReply:user-1' if name=='unacceptedReply' else 'send:恢复验证'
        started=time.time(); launch(f'500:screen:chat;1200:{command};2400:historySnapshot:before',token)
        before=snapshot('before',started)
        assert len(scenario['sends'])==1, (name,scenario)
        stop(); scenario['restarted']=True
        started=time.time(); launch('500:screen:chat;2200:historySnapshot:after',token)
        after=snapshot('after',started)
        assert len(after['ids'])==len(set(after['ids'])), (name,after)
        assert not after['waiting'] and not after['streaming'], (name,after)
        assert after['texts'].count('恢复验证')==1, (name,after)
        if name in ['streaming','completed','unaccepted','stopped','unacceptedReply']:
            assert after['texts'].count('完整回复')==1 and '半截' not in after['texts'], (name,after)
        if name in ['unaccepted','unacceptedReply']: assert len(scenario['sends'])==2 and len(set(scenario['sends']))==1
        else: assert len(scenario['sends'])==1
        if name=='completed': assert scenario['resumes']==0
        if name=='stopped': assert after['states'][-1]=='stopped'
        if name=='failed': assert after['states'][-1]=='timeout'
        if name=='superseded': assert len(after['ids'])==1
        print(f'PASS: {name} 重启恢复，发送幂等、无重复气泡、等待状态收束。',flush=True)
finally:
    stop(); server.shutdown()
