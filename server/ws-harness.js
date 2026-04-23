const WebSocket = require('ws');

const session = process.argv[2] || 'test-harness';
const url = 'ws://127.0.0.1:3000/ws';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'join', role, session }));
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

async function main() {
  const stage = await connect('stage');
  const controller = await connect('controller');

  stage.on('message', (raw) => {
    console.log(`[stage] ${raw.toString()}`);
  });

  controller.on('message', (raw) => {
    console.log(`[controller] ${raw.toString()}`);
  });

  const send = (payload) => {
    console.log(`[controller->server] ${JSON.stringify(payload)}`);
    controller.send(JSON.stringify(payload));
  };

  await wait(150);
  send({ type: 'orient', alpha: 0, beta: 0, gamma: -30 });
  await wait(80);
  send({ type: 'down', alpha: 0, beta: 0, gamma: -30 });
  for (let gamma = -20; gamma <= 30; gamma += 10) {
    await wait(80);
    send({ type: 'orient', alpha: 0, beta: 0, gamma });
  }
  await wait(80);
  send({ type: 'up' });

  await wait(250);
  stage.close();
  controller.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
