/**
 * VitalGrid - Controlador de Telemetría y Cockpit Aeroespacial Crew Dragon
 * NASA Space Apps Challenge - Monitoreo de Salud de Astronautas en Espacio Profundo
 */

document.addEventListener('DOMContentLoaded', () => {
    // --- Variables de Estado ---
    let ws = null;
    let wsUrl = 'ws://127.0.0.1:9002';
    let reconnectTimer = null;
    let activeAlerts = new Map();
    let currentPayload = null;
    let somaTriggered = false;

    // --- Elementos del DOM ---
    const connectionPill = document.getElementById('connectionPill');
    const connectionLabel = document.getElementById('connectionLabel');
    const somaPill = document.getElementById('somaPill');
    const somaLabel = document.getElementById('somaLabel');
    const muteBtn = document.getElementById('muteBtn');
    const somaStrip = document.getElementById('somaStrip');
    const somaDetailsCard = document.getElementById('somaDetailsCard');
    const metClock = document.getElementById('metClock');
    const utcClock = document.getElementById('utcClock');
    const rawJsonViewer = document.getElementById('rawJsonViewer');
    const directivesList = document.getElementById('directivesList');

    // Salud y Supervivencia
    const healthScoreNum = document.getElementById('healthScoreNum');
    const healthGaugeProgress = document.getElementById('healthGaugeProgress');
    const crewIdEl = document.getElementById('crewId');
    const vitalSignsPill = document.getElementById('vitalSignsPill');
    const sosPill = document.getElementById('sosPill');
    const cabinPressurePill = document.getElementById('cabinPressurePill');

    // Canvas ECG
    const ecgCanvas = document.getElementById('ecgCanvas');
    const ecgCtx = ecgCanvas.getContext('2d');
    const ecgBpmDisplay = document.getElementById('ecgBpmDisplay');

    // --- Inicialización de Audio al hacer clic ---
    document.body.addEventListener('click', () => {
        window.aerospaceAudio.init();
    }, { once: true });

    muteBtn.addEventListener('click', () => {
        const isMuted = window.aerospaceAudio.toggleMute();
        muteBtn.textContent = isMuted ? 'ACTIVAR AUDIO' : 'SILENCIAR AUDIO';
        muteBtn.style.color = isMuted ? 'var(--text-muted)' : 'var(--hud-cyan)';
    });

    // --- Reloj de Tiempo Transcurrido de Misión (MET) ---
    let metSeconds = 42 * 86400 + 18 * 3600 + 24 * 60 + 12;
    setInterval(() => {
        metSeconds++;
        const d = Math.floor(metSeconds / 86400);
        const h = Math.floor((metSeconds % 86400) / 3600);
        const m = Math.floor((metSeconds % 3600) / 60);
        const s = metSeconds % 60;
        metClock.textContent = `MET +${String(d).padStart(3, '0')}:${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        utcClock.textContent = new Date().toISOString().substring(11, 19) + ' UTC';
    }, 1000);

    // --- Generador en Tiempo Real de ECG en Canvas ---
    let ecgPoints = [];
    let ecgX = 0;
    let currentBpm = 105;
    let isVitalsPresent = true;

    function resizeCanvas() {
        if (!ecgCanvas) return;
        ecgCanvas.width = ecgCanvas.clientWidth * window.devicePixelRatio;
        ecgCanvas.height = ecgCanvas.clientHeight * window.devicePixelRatio;
        ecgCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    function drawECG() {
        const w = ecgCanvas.clientWidth;
        const h = ecgCanvas.clientHeight;
        const midY = h / 2;

        ecgCtx.fillStyle = 'rgba(4, 7, 11, 0.2)';
        ecgCtx.fillRect(0, 0, w, h);

        // Cuadrícula de derivación
        ecgCtx.strokeStyle = 'rgba(0, 243, 255, 0.05)';
        ecgCtx.lineWidth = 1;
        for (let gx = 0; gx < w; gx += 20) {
            ecgCtx.beginPath();
            ecgCtx.moveTo(gx, 0);
            ecgCtx.lineTo(gx, h);
            ecgCtx.stroke();
        }
        for (let gy = 0; gy < h; gy += 20) {
            ecgCtx.beginPath();
            ecgCtx.moveTo(0, gy);
            ecgCtx.lineTo(w, gy);
            ecgCtx.stroke();
        }

        // Generar siguiente muestra ECG
        let sample = 0;
        if (!isVitalsPresent) {
            // Asistolia: línea plana con ruido sensor de baja amplitud
            sample = (Math.random() - 0.5) * 1.5;
        } else {
            const beatPeriod = Math.max(30, Math.floor(3600 / currentBpm));
            const phase = ecgX % beatPeriod;

            if (phase >= 10 && phase < 14) {
                // Onda P
                sample = Math.sin((phase - 10) / 4 * Math.PI) * 7;
            } else if (phase === 20) {
                // Caída Q
                sample = -10;
            } else if (phase === 22) {
                // Pico R (deflexión rápida)
                sample = 42;
            } else if (phase === 24) {
                // Caída S
                sample = -16;
            } else if (phase >= 32 && phase < 42) {
                // Onda T
                sample = Math.sin((phase - 32) / 10 * Math.PI) * 12;
            } else {
                sample = (Math.random() - 0.5) * 2;
            }
        }

        const pointY = midY - sample;
        ecgPoints.push({ x: ecgX % w, y: pointY });
        if (ecgPoints.length > w) {
            ecgPoints.shift();
        }

        // Trazo del haz
        ecgCtx.beginPath();
        ecgCtx.strokeStyle = isVitalsPresent ? '#00f3ff' : '#ff0055';
        ecgCtx.lineWidth = 2;
        ecgCtx.shadowColor = isVitalsPresent ? 'rgba(0, 243, 255, 0.8)' : 'rgba(255, 0, 85, 0.9)';
        ecgCtx.shadowBlur = 8;

        const currentPos = ecgX % w;
        for (let i = 1; i < ecgPoints.length; i++) {
            const p0 = ecgPoints[i - 1];
            const p1 = ecgPoints[i];
            if (Math.abs(p1.x - p0.x) < 5) {
                ecgCtx.moveTo(p0.x, p0.y);
                ecgCtx.lineTo(p1.x, p1.y);
            }
        }
        ecgCtx.stroke();
        ecgCtx.shadowBlur = 0;

        // Limpieza de cabeza de barrido
        ecgCtx.clearRect((currentPos + 1) % w, 0, 16, h);

        ecgX++;
        requestAnimationFrame(drawECG);
    }
    requestAnimationFrame(drawECG);

    // --- Cliente WebSocket ---
    function connectWebSocket() {
        console.log(`[VitalGrid UI] Conectando a ${wsUrl}...`);
        connectionLabel.textContent = 'CONECTANDO...';
        connectionPill.className = 'status-pill disconnected';

        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            console.error('[WS ERROR]', e);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            console.log('[VitalGrid UI] Conectado con el Demonio C++ del IA Médico de Vuelo');
            connectionLabel.textContent = 'TELEMETRÍA EN LÍNEA';
            connectionPill.className = 'status-pill connected';
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleIncomingMessage(data, event.data);
            } catch (err) {
                console.error('[ERROR PARSEANDO JSON]', err, event.data);
            }
        };

        ws.onclose = () => {
            console.warn('[VitalGrid UI] Conexión cerrada');
            connectionLabel.textContent = 'DESCONECTADO (REINTENTANDO)';
            connectionPill.className = 'status-pill disconnected';
            marcarTodoSinMedicion();
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error('[ERROR DE SOCKET WS]', err);
            ws.close();
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 2000);
    }

    // --- Despachador de Mensajes ---
    function handleIncomingMessage(msg, rawString) {
        if (msg.type === 'SOMA_DSOC_EVENT') {
            handleSomaEvent(msg);
            return;
        }

        if (msg.type === 'CLINICAL_ALERT') {
            handleClinicalAlert(msg);
            return;
        }

        if (msg.crew_member_id && msg.telemetry_ridge) {
            handleRidgeTelemetry(msg, rawString);
        }
    }

    // --- Formato seguro de valores -----------------------------------------
    // Devuelven null cuando el dato no llegó. setMetric interpreta null como
    // "sin medición" y pinta la celda en gris, en vez de mostrar un número viejo.
    const esNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const f = (v, dec) => esNum(v) ? v.toFixed(dec) : null;
    const n = (v) => (v === null || v === undefined) ? null : v;

    // --- Ingestión de Telemetría RIDGE ---
    function handleRidgeTelemetry(data, raw) {
        currentPayload = data;
        rawJsonViewer.textContent = JSON.stringify(data, null, 2);

        crewIdEl.textContent = data.crew_member_id || 'CMD-01';

        // Nivel de Salud
        // Si el backend no manda el puntaje, no asumimos salud perfecta:
        // lo mostramos como sin medición.
        const sinScore = !esNum(data.health_score);
        const score = sinScore ? 0 : data.health_score;
        healthScoreNum.textContent = sinScore ? '—' : score;

        // Progreso del anillo (circunferencia = 2 * PI * 70 = 440)
        const offset = 440 - (score / 100) * 440;
        healthGaugeProgress.style.strokeDashoffset = sinScore ? 440 : offset;

        if (sinScore) {
            healthGaugeProgress.style.stroke = 'var(--text-muted)';
            healthScoreNum.style.color = 'var(--text-muted)';
        } else if (score >= 80) {
            healthGaugeProgress.style.stroke = 'var(--bio-green)';
            healthScoreNum.style.color = '#fff';
        } else if (score >= 50) {
            healthGaugeProgress.style.stroke = 'var(--warn-amber)';
            healthScoreNum.style.color = 'var(--warn-amber)';
        } else {
            healthGaugeProgress.style.stroke = 'var(--crit-crimson)';
            healthScoreNum.style.color = 'var(--crit-crimson)';
        }

        // Tríada de Supervivencia
        const surv = data.survival_status || {};
        isVitalsPresent = surv.vital_signs_present;

        updateSurvivalPill(vitalSignsPill, surv.vital_signs_present, 'DETECTADOS (ACTIVO)', 'ASISTOLIA / PARO CARDÍACO');
        updateSurvivalPill(sosPill, !surv.sos_panic_button_active, 'ARMADO (EN ESPERA)', 'ACTIVADO (EMERGENCIA)');
        updateSurvivalPill(cabinPressurePill, surv.cabin_pressure_nominal, '101.3 kPa NOMINAL', '¡DESCOMPRESIÓN DE CABINA!');

        // Actualizar Métricas RIDGE
        // Si falta un bloque entero, seguimos igual: esas celdas quedan en gris
        // en vez de cortar la función y dejar la pantalla congelada.
        const ridge = data.telemetry_ridge || {};
        const r = ridge.R_radiation  || {};
        const i = ridge.I_isolation  || {};
        const d = ridge.D_distance   || {};
        const g = ridge.G_gravity    || {};
        const e = ridge.E_environment || {};

        if (esNum(g.heart_rate_bpm)) currentBpm = g.heart_rate_bpm;
        ecgBpmDisplay.textContent = esNum(g.heart_rate_bpm) ? `${g.heart_rate_bpm} LPM` : '— LPM';

        // R - Radiación
        setMetric('val_rad_acute', f(r.acute_event_mSv, 1), r.acute_event_mSv > 250);
        setMetric('val_rad_career', f(r.career_accumulated_mSv, 1), r.career_accumulated_mSv > 600);
        const careerPct = esNum(r.career_accumulated_mSv)
            ? Math.min(100, (r.career_accumulated_mSv / 600) * 100) : 0;
        const careerBar = document.getElementById('careerRadBar');
        if (careerBar) {
            careerBar.style.width = `${careerPct}%`;
            careerBar.className = 'progress-bar-fill ' + (careerPct > 80 ? 'crit' : careerPct > 50 ? 'warn' : '');
        }

        // I - Aislamiento
        setMetric('val_sleep_hours', f(i.sleep_hours_last_24h, 1), false, i.sleep_hours_last_24h < 6.0);
        setMetric('val_hrv_drop', f(i.hrv_rmssd_drop_pct, 1), false, i.hrv_rmssd_drop_pct > 25.0);
        setMetric('val_pvt_ms', n(i.pvt_reaction_time_ms), false, i.pvt_reaction_time_ms > 350);

        // D - Distancia
        setMetric('val_comm_delay', f(d.comm_delay_oneway_min, 1), false);
        setMetric('val_med_supply', n(d.med_supply_days_remaining), false);

        // G - Gravedad / Cardio / SANS
        setMetric('val_hr', n(g.heart_rate_bpm), g.heart_rate_bpm > 110 || g.heart_rate_bpm === 0);
        const bpText = (esNum(g.blood_pressure_sys) && esNum(g.blood_pressure_dia))
            ? `${g.blood_pressure_sys}/${g.blood_pressure_dia}` : null;
        setMetric('val_bp', bpText, g.blood_pressure_sys > 155 || g.blood_pressure_dia > 95);
        setMetric('val_onsd', f(g.onsd_mm, 2), g.onsd_mm > 5.8);
        setMetric('val_exercise', f(g.exercise_completed_hours, 1), false);

        // E - Entorno
        setMetric('val_ppco2', f(e.cabin_ppco2_mmHg, 2), e.cabin_ppco2_mmHg > 3.0);
        setMetric('val_spo2', n(e.spo2_pct), e.spo2_pct < 95);
        setMetric('val_temp', f(e.body_temperature_c, 1), e.body_temperature_c > 38.5);

        // Reinicio automático de indicador SOMA si se restituyen las constantes
        if (surv.vital_signs_present && !surv.sos_panic_button_active && surv.cabin_pressure_nominal) {
            if (somaTriggered) {
                somaTriggered = false;
                somaPill.className = 'status-pill soma-standby';
                somaLabel.textContent = 'WATCHDOG SOMA: NOMINAL';
                somaStrip.classList.remove('visible');
                somaDetailsCard.classList.remove('visible');
                window.aerospaceAudio.stopAlarm();
            }
        }
    }

    function setMetric(elemId, value, isCrit, isWarn = false) {
        const el = document.getElementById(elemId);
        if (!el) return;

        // Tarea 37: tres estados, no dos. La ausencia de dato no es salud.
        const sinDato = (value === null || value === undefined || value === '');
        el.textContent = sinDato ? '—' : value;

        const cell = el.closest('.metric-cell');
        if (cell) {
            cell.classList.remove('critical-breach', 'warning-breach', 'no-data');
            if (sinDato) {
                cell.classList.add('no-data');
            } else if (isCrit) {
                cell.classList.add('critical-breach');
            } else if (isWarn) {
                cell.classList.add('warning-breach');
            }
        }
    }

    // Marca todo el tablero como sin medición. Se usa al arrancar (antes del
    // primer mensaje) y cuando se cae la conexión: así nadie lee como actual
    // un número que quedó de hace diez minutos.
    function marcarTodoSinMedicion() {
        document.querySelectorAll('.metric-cell').forEach(cell => {
            cell.classList.remove('critical-breach', 'warning-breach');
            cell.classList.add('no-data');
            const val = cell.querySelector('.metric-value');
            if (val) val.textContent = '—';
        });
        healthScoreNum.textContent = '—';
        healthScoreNum.style.color = 'var(--text-muted)';
        healthGaugeProgress.style.stroke = 'var(--text-muted)';
        healthGaugeProgress.style.strokeDashoffset = 440;
    }

    function updateSurvivalPill(element, isNominal, nominalText, dangerText) {
        if (!element) return;
        element.className = `survival-pill ${isNominal ? 'nominal' : 'danger'}`;
        const tag = element.querySelector('.tag');
        if (tag) {
            tag.textContent = isNominal ? nominalText : dangerText;
        }
    }

    // --- Ingestión de Alertas Clínicas del Flight Surgeon AI ---
    function handleClinicalAlert(alert) {
        const key = alert.trigger_metric;
        activeAlerts.set(key, { ...alert, receivedAt: new Date() });
        renderDirectives();

        if (alert.status === 'CRITICAL') {
            window.aerospaceAudio.startMasterAlarm();
        } else if (alert.status === 'WARNING') {
            window.aerospaceAudio.playCautionChime();
        }
    }

    function renderDirectives() {
        directivesList.innerHTML = '';

        if (activeAlerts.size === 0) {
            directivesList.innerHTML = `
                <div class="directive-card NOMINAL">
                    <div class="directive-header">
                        <span class="directive-status-tag">NOMINAL</span>
                        <span class="directive-time">IA MÉDICO DE VUELO ACTIVO</span>
                    </div>
                    <div class="directive-diagnosis">TODOS LOS ESTÁNDARES BIOMÉDICOS DENTRO DE LOS LÍMITES NASA</div>
                    <div class="directive-trigger">Monitoreo pasivo continuo activo en los 5 pilares RIDGE.</div>
                    <div class="directive-action-box">
                        <div class="directive-action-label">Directiva:</div>
                        Mantener tareas operacionales de espacio profundo y ejercicios de contramedidas programados.
                    </div>
                </div>
            `;
            return;
        }

        // Ordenar por severidad crítica primero
        const sorted = Array.from(activeAlerts.values()).sort((a, b) => {
            if (a.status === 'CRITICAL' && b.status !== 'CRITICAL') return -1;
            if (b.status === 'CRITICAL' && a.status !== 'CRITICAL') return 1;
            return 0;
        });

        sorted.forEach(alert => {
            const card = document.createElement('div');
            card.className = `directive-card ${alert.status}`;
            card.innerHTML = `
                <div class="directive-header">
                    <span class="directive-status-tag">${alert.status}</span>
                    <span class="directive-time">${alert.timestamp || new Date().toISOString().substring(11, 19) + ' UTC'}</span>
                </div>
                <div class="directive-diagnosis">${alert.diagnosis}</div>
                <div class="directive-trigger">Disparador: ${alert.trigger_metric} = ${alert.trigger_value} (${alert.threshold_limit})</div>
                <div class="directive-action-box">
                    <div class="directive-action-label">ACCIÓN TÁCTICA INMEDIATA:</div>
                    ${alert.tactical_action}
                </div>
            `;
            directivesList.appendChild(card);
        });
    }

    // --- Ingestión de Evento de Emergencia SOMA DSOC ---
    function handleSomaEvent(soma) {
        console.warn('[RÁFAGA DE EMERGENCIA SOMA RECIBIDA]', soma);
        somaTriggered = true;

        somaPill.className = 'status-pill soma-active';
        somaLabel.textContent = 'SOMA: CIENCIA SOBRE SUPERVIVENCIA';
        somaStrip.classList.add('visible');

        document.getElementById('somaReasonText').textContent = soma.trigger_reason;
        document.getElementById('somaDsocStation').textContent = soma.target_ground_station;
        document.getElementById('somaDelayText').textContent = `${soma.light_delay_minutes} min retardo lumínico`;

        // Llenar tarjeta de detalles forenses SOMA
        somaDetailsCard.classList.add('visible');
        document.getElementById('somaSamplesCount').textContent = `${soma.historical_samples_count} registros (1000 Hz)`;
        document.getElementById('somaDataSize').textContent = `${soma.raw_payload_bytes} B sin comprimir → ${soma.compressed_payload_bytes} B`;
        document.getElementById('somaCompression').textContent = `${soma.compression_algorithm} (Ratio: ${soma.compression_ratio}x)`;
        document.getElementById('somaCipher').textContent = soma.encryption_cipher;
        document.getElementById('somaNonce').textContent = soma.iv_nonce_hex;
        document.getElementById('somaTag').textContent = soma.auth_tag_hex;

        window.aerospaceAudio.playDsocBurstLaser();
        window.aerospaceAudio.startMasterAlarm();
    }

    // --- Cockpit de Simulación Interactiva ---
    function sendCommand(cmd) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            alert('Conexión WebSocket no establecida. Asegúrate de que vitalgrid_daemon.exe esté ejecutándose en el puerto 9002.');
            return;
        }
        ws.send(cmd);
        console.log(`[COMANDO VITALGRID ENVIADO] ${cmd}`);
    }

    // Vincular botones de inyección de anomalías
    document.getElementById('btnSos')?.addEventListener('click', () => sendCommand('TRIGGER_SOS'));
    document.getElementById('btnDepressurize')?.addEventListener('click', () => sendCommand('DEPRESSURIZE'));
    document.getElementById('btnAsystole')?.addEventListener('click', () => sendCommand('ASYSTOLE'));
    document.getElementById('btnHypoxia')?.addEventListener('click', () => sendCommand('INJECT_HYPOXIA'));
    document.getElementById('btnHypercapnia')?.addEventListener('click', () => sendCommand('INJECT_HYPERCAPNIA'));
    document.getElementById('btnSans')?.addEventListener('click', () => sendCommand('INJECT_SANS'));
    document.getElementById('btnSpeRadiation')?.addEventListener('click', () => sendCommand('INJECT_SPE_RADIATION'));
    document.getElementById('btnFever')?.addEventListener('click', () => sendCommand('INJECT_FEVER'));
    document.getElementById('btnFatigue')?.addEventListener('click', () => sendCommand('INJECT_FATIGUE'));
    
    document.getElementById('btnResetNominal')?.addEventListener('click', () => {
        activeAlerts.clear();
        renderDirectives();
        window.aerospaceAudio.stopAlarm();
        sendCommand('RESET_NOMINAL');
    });

    document.getElementById('btnResetSurvival')?.addEventListener('click', () => {
        window.aerospaceAudio.stopAlarm();
        sendCommand('RESET_SURVIVAL');
    });

    // Arrancamos sin dato: los números del HTML son de relleno, no mediciones.
    marcarTodoSinMedicion();

    // Iniciar conexión WebSocket
    connectWebSocket();
});
