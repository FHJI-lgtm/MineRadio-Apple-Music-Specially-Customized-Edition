const run = async () => {
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
console.log('reload requested');
setTimeout(() => process.exit(0), 1500);
};
run();
