const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let mainWindow;
let client;

// CONTROLE DE PAUSA/PARADA
let isPaused = false;
let isStopped = false;

// Função para criar a janela principal
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 850,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('public/index.html');
}

// App ready
app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Para compatibilidade com macOS
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// --- Funções de controle IPC ---
ipcMain.on('pause-whatsapp', () => {
    isPaused = true;
    if (mainWindow) mainWindow.webContents.send('status_update', 'Envio pausado!');
});

ipcMain.on('resume-whatsapp', () => {
    isPaused = false;
    if (mainWindow) mainWindow.webContents.send('status_update', 'Envio retomado!');
});

ipcMain.on('stop-whatsapp', () => {
    isStopped = true;
    if (mainWindow) {
        mainWindow.webContents.send('status_update', 'Envio parado pelo usuário.');
        mainWindow.loadFile('public/index.html');
    }
    // Se quiser, pode destruir o client:
    if (client) client.destroy();
});

// --- Fluxo principal de envio ---
ipcMain.on('start-whatsapp', async (event, { filePath, messageTemplate }) => {
    isPaused = false;
    isStopped = false;

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', async (qr) => {
        const qrDataUrl = await qrcode.toDataURL(qr);
        if (mainWindow) mainWindow.webContents.send('qr_code', qrDataUrl);
    });

    client.on('ready', async () => {
        if (mainWindow) mainWindow.webContents.send('session_ready');

        const contatosComFalha = [];
        let linhas;
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            linhas = data.split(/\r?\n/).filter(linha => linha.trim() !== '');
            if (mainWindow) mainWindow.webContents.send('status_update', `Arquivo lido. ${linhas.length} contatos encontrados. Iniciando envios...`);
        } catch (err) {
            if (mainWindow) mainWindow.webContents.send('status_update', `Erro ao ler o arquivo: ${err.message}`);
            return;
        }

        let contadorSucesso = 0;
        for (let i = 0; i < linhas.length; i++) {
            if (isStopped) break;

            const linha = linhas[i];
            let nome = `Linha ${i + 1}`;
            let telefone = '';

            try {
                if (linha) {
                    const colunas = linha.split(';');
                    if (colunas.length >= 2) {
                        nome = colunas[0].trim();
                        telefone = colunas[1].trim();
                        if (!telefone) throw new Error("Número de telefone vazio.");

                        const numeroFormatado = `55${telefone}@c.us`;
                        const mensagemFinal = messageTemplate.replace(/{nome}/g, nome);

                        const statusMsg = `(${i + 1}/${linhas.length}) Enviando para: ${nome}`;
                        if (mainWindow) mainWindow.webContents.send('status_update', statusMsg);

                        await client.sendMessage(numeroFormatado, mensagemFinal);

                        contadorSucesso++;
                        // --- Controle de PAUSA ---
                        while (isPaused && !isStopped) {
                            await delay(1000);
                        }
                        if (isStopped) break;

                        if (contadorSucesso > 0 && contadorSucesso % 50 === 0 && (i + 1) < linhas.length) {
                            if (mainWindow) mainWindow.webContents.send('status_update', `PAUSA DE 60 SEGUNDOS... (${contadorSucesso} enviados)`);
                            await delay(60000);
                        } else {
                            await delay(15000);
                        }
                    }
                }
            } catch (err) {
                console.error(`ERRO ao enviar para ${nome}: ${err.message}`);
                contatosComFalha.push({ nome, telefone, erro: err.message });
                if (mainWindow) mainWindow.webContents.send('status_update', `Erro ao enviar para ${nome}. Pulando...`);
                await delay(5000);
            }
        }

        if (!isStopped) {
            let finalReport = `Processo finalizado! ${contadorSucesso} mensagens enviadas com sucesso.`;
            if (contatosComFalha.length > 0) {
                finalReport += `\n\n--- RELATÓRIO DE FALHAS ---\n` + contatosComFalha.map(c => `- ${c.nome} (${c.telefone}): ${c.erro}`).join('\n');
            }
            if (mainWindow) mainWindow.webContents.send('status_update', finalReport);
        }
        // Finaliza sessão whatsapp se quiser
        // if (client) client.destroy();
    });

    client.initialize();
});

// Função de delay
function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// Diálogo de seleção de arquivo
ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Arquivos CSV', extensions: ['csv'] }]
    });
    return canceled ? null : filePaths[0];
});
