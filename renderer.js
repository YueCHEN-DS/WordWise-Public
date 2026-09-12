const isElectron = Boolean(window.electronAPI);

    let words = [];
    let wordsDb = [];
    let wordSet = new Set();
    let wordMap = new Map();
    let currentWord = null;
    let currentWordObj = null;
    let currentWordIdx = -1;
    let quizMode = "random";
    let practiceCount = "all";
    let epochTotal = 0;
    let epochNumber = 1;
    let sequentialIndex = 0;
    let autoAdvanceTimer = null;
    let autoAdvanceInterval = null;
    let advanceInFlight = false;
    let questionGenerationToken = 0;
    let mistakeReviewActive = false;
    let currentMistake = null;
    let lastDisplayedMistakeId = null;
    let currentScore = 100;
    const SCORE_KEY = "vocab_tester_score";
    let confusionMapEdges = [];
    let isDemoMode = false;
    let demoScenario = null;
    let appConfig = {};
    let currentModelProfile = null;
    const compactModelProfiles = new Set(['low', 'wordwise']);
    let hardwareCapability = null;
    let modelProfiles = {};
    let isModelOperationRunning = false;

    let currentDifficulty = 3;
    let adaptiveWordsCompleted = 0;
    const DIFFICULTY_KEY = "vocab_tester_difficulty";

    // performance.now() 精度比 Date.now() 高，且不受系统时钟调整影响
    let answerStartTime = 0;

    let isFirstAttempt = true;
    let $currentWord, $wordIndex, $answerInput, $newWordInput,
      $resultBox, $loading, $checkBtn, $wordList, $wordCount,
      $epochFill, $epochCount, $epochLabel,
      $toggleListBtn, $modeRandomBtn, $modeSeqBtn, $modelStatus;

        async function init() { // 初始化
      $currentWord = document.getElementById("currentWord");
      $wordIndex = document.getElementById("wordIndex");
      $answerInput = document.getElementById("answerInput");
      $newWordInput = document.getElementById("newWordInput");
      $resultBox = document.getElementById("resultBox");
      $loading = document.getElementById("loading");
      $checkBtn = document.getElementById("checkBtn");
      $wordList = document.getElementById("wordList");
      $wordCount = document.getElementById("wordCount");
      $epochFill = document.getElementById("epochFill");
      $epochCount = document.getElementById("epochCount");
      $epochLabel = document.getElementById("epochLabel");
      $toggleListBtn = document.getElementById("toggleListBtn");
      $modeRandomBtn = document.getElementById("modeRandomBtn");
      $modeSeqBtn = document.getElementById("modeSeqBtn");
      $modelStatus = document.getElementById("modelStatus");

      if (isElectron) {
        try {
          appConfig = await window.electronAPI.getConfig() || {};
        } catch (error) {
          console.warn('[Config] Init failed:', error);
          appConfig = {};
        }
      }

      isDemoMode = Boolean(appConfig.demoMode && window.WordWiseDemo);
      appConfig.autoAdvanceEnabled = appConfig.autoAdvanceEnabled !== false;
      appConfig.autoAdvanceDelayMs = [1500, 3000, 5000, 8000].includes(appConfig.autoAdvanceDelayMs)
        ? appConfig.autoAdvanceDelayMs
        : 1500;
      syncAutoAdvanceSettings();
      document.body.classList.toggle('demo-mode-active', isDemoMode);
      updateDemoModeSettings();

      if (isDemoMode) {
        const lists = window.WordWiseDemo.getLists();
        const sel = document.getElementById('vocabListSelect');
        if (sel) {
          sel.innerHTML = lists.map(list =>
            `<option value="${escapeHtml(list.file)}">${escapeHtml(list.name)}</option>`
          ).join('');
          sel.value = window.WordWiseDemo.defaultList;
        }
        demoScenario = window.WordWiseDemo.getScenario(window.WordWiseDemo.defaultList);
        wordsDb = demoScenario.words;
        words = wordsDb.map(word => word.term);
      } else if (isElectron) {
        try {
          const lists = await window.electronAPI.db.getAvailableLists();
          const sel = document.getElementById('vocabListSelect');
          if (sel) {
            sel.innerHTML = lists.map(l => `<option value="${escapeHtml(l.file)}">${escapeHtml(l.name)}</option>`).join('');

            const savedListFile = localStorage.getItem('vocab_tester_active_list_file');
            const activeListFile = lists.some(list => list.file === savedListFile)
              ? savedListFile
              : lists[0]?.file;
            if (activeListFile) {
              sel.value = activeListFile;
              const switched = await window.electronAPI.db.switchList(activeListFile);
              if (!switched) throw new Error(`无法打开词库: ${activeListFile}`);
            }
          }

          wordsDb = await window.electronAPI.db.getAllWords();
          words = wordsDb.map(w => w.term);
          await refreshMistakeQueueStatus();
        } catch (e) {
          console.error('[SQLite] Init failed:', e);
          showToast('数据库初始化失败', 'error');
        }
      } else {
        words = ["Example", "Word", "Test"];
      }

      syncWordSet();
      renderWordList();

      if (isElectron) {
        window.electronAPI.onModelStatus((data) => {
          if (!isDemoMode) updateModelStatusUI(data);
        });

        window.electronAPI.onDownloadProgress((data) => {
          if (!isDemoMode) updateDownloadProgress(data);
        });

        window.electronAPI.onGpuBackend((data) => {
          if (isDemoMode) return;
          const lbl = document.getElementById('hwAccelLabel');
          if (lbl) {
            const names = { cuda: 'CUDA', metal: 'Metal', vulkan: 'Vulkan', cpu: 'CPU' };
            const backendName = names[data.backend] || data.backend;
            const tierLabel = data.gpuTier ? ` · ${data.gpuTier.toUpperCase()}` : '';
            lbl.textContent = '硬件加速 (' + backendName + tierLabel + ')';
          }
        });

        window.electronAPI.onInferencePerf?.((data) => {
          if (isDemoMode) return;
          if (data.event === 'timeout_retry') {
            showToast(`推理超时，正在重试 (${data.nextTimeoutMs / 1000}s)...`, 'warning');
          }
        });

        window.electronAPI.onLowModeRecommendation?.((data) => {
          if (!isDemoMode) showLowModeRecommendation(data.capability);
        });

        if (window.electronAPI.license) {
          initLicenseUI();
        }

        const toggle = document.getElementById('hwAccelToggle');
        const visualToggle = document.getElementById('hwAccelToggle_visual');
        const useGpu = isDemoMode ? true : appConfig.useGpu !== false;
        if (toggle) toggle.checked = useGpu;
        if (visualToggle) visualToggle.checked = useGpu;

        if (isDemoMode) {
          const lbl = document.getElementById('hwAccelLabel');
          if (lbl) lbl.textContent = '硬件加速 (Metal)';
          updateModelStatusUI({
            status: 'ready',
            profile: 'pro',
            runtimeTier: 'high',
            displayLabel: 'QWEN-Pro (High)',
            message: 'QWEN-Pro (High) 已加载',
          });
        } else {
          if (appConfig.useGpu === undefined) {
            appConfig.useGpu = true;
            await window.electronAPI.updateConfig({ useGpu: true });
          }
          await initializeAiRuntime();
        }

        const bgEnabled = localStorage.getItem('vocab_tester_bg_enabled') !== 'false';
        const bgToggle = document.getElementById('bgToggle');
        if (bgToggle) bgToggle.checked = bgEnabled;
        if (!bgEnabled) document.body.classList.add('bg-disabled');

        // 新词自动朗读开关（默认关闭）
        const autoReadToggle = document.getElementById('autoReadToggle');
        if (autoReadToggle) autoReadToggle.checked = appConfig.autoReadWord === true;
      }

      if (isDemoMode) {
        quizMode = 'random';
      } else {
        const savedMode = localStorage.getItem("vocab_tester_mode");
        if (savedMode === "sequential" || savedMode === "random" || savedMode === "adaptive") {
          quizMode = savedMode;
        }
      }
      updateModeToggleUI();

      if (isDemoMode) {
        currentDifficulty = demoScenario.difficulty;
      } else {
        const savedDiff = localStorage.getItem(DIFFICULTY_KEY);
        if (savedDiff) currentDifficulty = parseInt(savedDiff, 10) || 3;
      }
      updateDifficultyUI(currentDifficulty);

      practiceCount = isDemoMode ? '10' : (localStorage.getItem("vocab_tester_count") || "all");
      const $pc = document.getElementById("practiceCount");
      if ($pc) $pc.value = practiceCount;

      if (isDemoMode) {
        currentScore = demoScenario.score;
      } else {
        const storedScore = localStorage.getItem(SCORE_KEY);
        if (storedScore !== null) {
          const parsedScore = Number.parseInt(storedScore, 10);
          if (Number.isFinite(parsedScore)) currentScore = parsedScore;
        }
      }
      updateScoreUI();

      initEpoch();
      if (isDemoMode) renderDemoScene();

      $answerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") checkAnswer();
      });
      $newWordInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addWord();
      });

      window.addEventListener('beforeunload', invalidateQuestionFlow);

    }

    function updateDemoModeSettings() {
      const card = document.getElementById('demoModeSettingsCard');
      const state = document.getElementById('demoModeState');
      const description = document.getElementById('demoModeDescription');
      const button = document.getElementById('demoModeToggleBtn');
      if (!card || !state || !description || !button) return;

      card.classList.toggle('is-active', isDemoMode);
      state.textContent = isDemoMode ? '当前开启' : '当前关闭';
      description.textContent = isDemoMode
        ? '当前界面使用固定内容；退出后恢复真实词库、积分和学习记录。'
        : '使用固定内容展示判卷、分级提示、自适应学习和个人易混图，不会写入真实学习记录。';
      button.textContent = isDemoMode ? '退出演示模式' : '进入演示模式';
    }

    async function toggleDemoMode() {
      if (!isElectron) {
        showToast('演示模式仅在 Electron 桌面端可用。', 'warning');
        return;
      }
      const nextValue = !isDemoMode;
      const prompt = nextValue
        ? '进入演示模式后将显示固定内容，且不会写入真实学习记录。是否继续？'
        : '退出演示模式并恢复真实学习数据界面？';
      if (!confirm(prompt)) return;

      const button = document.getElementById('demoModeToggleBtn');
      if (button) button.disabled = true;
      try {
        const result = await window.electronAPI.updateConfig({ demoMode: nextValue });
        if (!result?.success) throw new Error(result?.error || '配置保存失败');
        window.location.reload();
      } catch (error) {
        if (button) button.disabled = false;
        showToast(`演示模式切换失败：${error.message}`, 'error');
      }
    }

    function setDemoScenario(listFile) {
      if (!isDemoMode || !window.WordWiseDemo) return;
      demoScenario = window.WordWiseDemo.getScenario(listFile);
      wordsDb = demoScenario.words;
      words = wordsDb.map(word => word.term);
      syncWordSet();
      renderWordList();
      renderDemoScene();
    }

    function renderDemoScene() {
      if (!isDemoMode || !demoScenario) return;

      clearAutoAdvance();
      resetHints();
      hideResult();
      hideScoreRing();
      hideStubbornBadge();
      const confusionAlert = document.getElementById('confusionAlertBox');
      if (confusionAlert) confusionAlert.style.display = 'none';

      currentWordObj = demoScenario.current;
      currentWord = currentWordObj.term;
      currentWordIdx = Math.max(0, demoScenario.position - 1);
      currentDifficulty = demoScenario.difficulty;
      currentScore = demoScenario.score;
      epochPool = [];
      epochTotal = 10;
      isFirstAttempt = true;

      displayCurrentWord();
      $wordIndex.textContent = `第 ${demoScenario.position} / ${demoScenario.totalWords} 个`;
      $wordCount.textContent = `共 ${demoScenario.totalWords} 个单词`;
      $answerInput.value = '';
      updateScoreUI();
      updateDifficultyUI(currentDifficulty);

      const hintSection = document.querySelector('.hints-stack');
      const masteryMeter = document.getElementById('masteryMeter');
      const reviewTag = document.getElementById('reviewTag');
      if (hintSection) hintSection.style.display = quizMode === 'random' ? 'flex' : 'none';
      if (masteryMeter) masteryMeter.classList.toggle('show', quizMode === 'adaptive');
      if (reviewTag) reviewTag.classList.toggle('show', quizMode === 'adaptive');

      if (quizMode === 'random') {
        renderDemoHints(demoScenario.hints.slice(0, demoScenario.hintDepth));
        $epochCount.textContent = '已完成 3 / 10';
        $epochLabel.textContent = '第 1 轮';
        $epochFill.style.width = '30%';
      } else if (quizMode === 'sequential') {
        $answerInput.value = demoScenario.answer;
        showResult('correct', '✅ 正确！', '回答准确，已覆盖该词的核心释义。', '紧凑语义评估');
        showScoreRing(96);
        $epochCount.textContent = '已完成 6 / 10';
        $epochLabel.textContent = '第 1 轮';
        $epochFill.style.width = '60%';
      } else {
        $answerInput.value = '结果；效果';
        updateMasteryMeter(demoScenario.mastery);
        showResult(
          'incorrect',
          '❌ 不正确',
          `你的回答没有覆盖“${demoScenario.answer}”这一标准释义，请注意相近词义的区别。`,
          '边界语义复核'
        );
        showScoreRing(42);
        showStubbornBadge();
        showConfusionAlert('检测到重复误答模式，已提高该词的复习优先级。');
        $epochCount.textContent = '自适应 · 已完成 12 词';
        $epochLabel.textContent = selectionReasonLabel(demoScenario.selectionReason);
        $epochFill.style.width = '68%';
      }
      answerStartTime = performance.now();
    }

    function renderDemoHints(hints) {
      hints.forEach((hint, index) => showHintResult(index + 1, hint));
      [1, 2, 3].forEach(level => {
        const button = document.getElementById(`hintLevel${level}Btn`);
        const container = document.getElementById(`hintLevel${level}Container`);
        const isRevealed = level <= hints.length;
        const isNext = level === hints.length + 1;
        if (button) button.style.display = isRevealed ? 'none' : 'block';
        if (container) container.style.display = isNext || (level === 1 && hints.length === 0) ? 'block' : 'none';
      });
    }

    async function refreshVocabList() {
      if (!isElectron) return;
      if (isDemoMode) {
        setDemoScenario(document.getElementById('vocabListSelect')?.value);
        showToast('词库内容已刷新。', 'success');
        return;
      }
      const sel = document.getElementById('vocabListSelect');
      const val = sel.value;
      const prettyName = sel.options[sel.selectedIndex].text;
      if (!val || val === 'Custom / My Words') {
        showToast('当前词表不支持刷新修复', 'warning');
        return;
      }

      if (!confirm(`确定要从源文件重新修复「${prettyName}」词库吗？\n这将会补充缺失的单词（不会删除你自己添加的标注）。`)) {
        return;
      }

      $loading.classList.add("show");
      const $btn = document.getElementById('refreshListBtn');
      if ($btn) $btn.disabled = true;

      try {
        const res = await window.electronAPI.db.refreshList(val);
        if (res.success) {
          wordsDb = await window.electronAPI.db.getAllWords();
          words = (wordsDb || []).map(w => w.term);
          syncWordSet();
          renderWordList();
          epochPool = [...words];
          initEpoch();
          showToast(`修复完成！新增 ${res.imported} 个单词。`, 'success');
        } else {
          showToast('修复失败: ' + (res.error || '未知错误'), 'error');
        }
      } catch (err) {
        console.error(err);
        showToast('发生错误: ' + err.message, 'error');
      } finally {
        $loading.classList.remove("show");
        if ($btn) $btn.disabled = false;
      }
    }

    async function changeVocabList() {
      invalidateQuestionFlow();
      mistakeReviewActive = false;
      currentMistake = null;
      lastDisplayedMistakeId = null;
      document.getElementById('mistakeReviewBtn')?.classList.remove('active');
      if (!isElectron) return;
      const sel = document.getElementById('vocabListSelect');
      const val = sel.value;
      const prettyName = sel.options[sel.selectedIndex].text;
      if (!val) return;

      if (isDemoMode) {
        setDemoScenario(val);
        showToast(`成功切换至: ${prettyName}`, 'success');
        return;
      }

      $loading.classList.add("show");
      if ($checkBtn) $checkBtn.disabled = true;

      try {
        const switched = await window.electronAPI.db.switchList(val);
        if (!switched) throw new Error(`无法打开词库: ${val}`);
        localStorage.setItem('vocab_tester_active_list_file', val);

        wordsDb = await window.electronAPI.db.getAllWords();
        words = (wordsDb || []).map(w => w.term);

        syncWordSet();
        renderWordList();

        epochPool = [...words];
        epochNumber = 1;
        initEpoch();

        currentWord = null;
        currentWordObj = null;
        currentWordIdx = -1;
        if ($currentWord) {
          $currentWord.textContent = '已切换词库，请点击下一步';
          $currentWord.className = 'word-placeholder';
        }
        if ($wordIndex) $wordIndex.textContent = '';
        if ($answerInput) $answerInput.value = '';

        updateProgressBar();
        hideResult();
        await refreshMistakeQueueStatus();

        showToast(`成功切换至: ${prettyName}`, 'success');
      } catch (err) {
        console.error(err);
        showResult('error-msg', '⚠️ 切换失败', err.message);
      } finally {
        $loading.classList.remove("show");
        if ($checkBtn) $checkBtn.disabled = false;
      }
    }

    function syncWordSet() {
      wordSet = new Set(words.map(word => word.toLowerCase()));
      wordMap = new Map();
      if (wordsDb) {
        const PHONETIC_REGEX = /\[.*?\]|\/.*?\//;
        for (const w of wordsDb) {
          const termLower = w.term.toLowerCase();
          if (w.meaning) {
            const match = w.meaning.match(PHONETIC_REGEX);
            if (match) w.phonetic = match[0];
          }
          wordMap.set(termLower, w);
        }
      }
    }

    async function initializeAiRuntime() {
      try {
        const state = await window.electronAPI.initializeAi();
        hardwareCapability = state.capability;
        modelProfiles = state.profiles || {};
        currentModelProfile = state.preference || state.activeProfile || null;
        renderHardwareCapability(hardwareCapability);
        renderModelProfileButtons();
        applyModelProfileUi(currentModelProfile);
        if (state.requiresChoice) showLowModeRecommendation(hardwareCapability);
      } catch (error) {
        console.error('[AI] initialization failed:', error);
        updateModelStatusUI({ status: 'error', message: `AI 初始化失败：${error.message}` });
      }
    }

    function renderHardwareCapability(capability) {
      const summary = document.getElementById('hardwareCapabilitySummary');
      if (!summary || !capability) return;
      const gpu = capability.gpuNames?.[0] || capability.backend?.toUpperCase() || '未知 GPU';
      const ram = capability.ramTotalBytes
        ? `${(capability.ramTotalBytes / 1024 ** 3).toFixed(0)} GiB RAM`
        : 'RAM 未知';
      const recommendation = capability.recommendLow ? '建议低算力模式' : '适合 QWEN-Pro';
      summary.textContent = `${gpu} · ${ram} · ${capability.logicalCores || '?'} 核 · ${recommendation}`;
    }

    function showLowModeRecommendation(capability) {
      hardwareCapability = capability || hardwareCapability;
      renderHardwareCapability(hardwareCapability);
      const overlay = document.getElementById('lowModeReminderOverlay');
      const list = document.getElementById('lowModeReasonList');
      const status = document.getElementById('lowModeReminderStatus');
      if (!overlay || !list) return;
      list.replaceChildren();
      const reasons = hardwareCapability?.reasons?.length
        ? hardwareCapability.reasons
        : [{ label: '设备算力检测结果不稳定，建议使用更轻量的模型。' }];
      for (const reason of reasons) {
        const item = document.createElement('div');
        item.className = 'low-mode-reason';
        item.textContent = `• ${reason.label}`;
        list.appendChild(item);
      }
      if (status) status.textContent = '';
      overlay.classList.add('active');
    }

    async function resolveLowModeRecommendation(profile) {
      const result = await startComputeMode(profile, { fromReminder: true });
      if (result?.success) {
        document.getElementById('lowModeReminderOverlay')?.classList.remove('active');
      }
    }

    async function startComputeMode(profile, options = {}) {
      invalidateQuestionFlow();
      if (!isElectron || isModelOperationRunning || !['pro', 'wordwise', 'low'].includes(profile)) return null;
      if (isDemoMode) {
        showToast('演示模式不会切换真实模型。', 'info');
        return { success: true };
      }
      isModelOperationRunning = true;
      setModelOperationBusy(true, profile);
      const reminderStatus = document.getElementById('lowModeReminderStatus');
      if (options.fromReminder && reminderStatus) {
        const profileName = profile === 'low'
          ? 'QWEN 低算力模式'
          : (profile === 'wordwise' ? 'QWEN-WordWise' : 'QWEN-Pro');
        reminderStatus.textContent = `正在准备 ${profileName}…`;
      }
      try {
        let result = await window.electronAPI.activateComputeMode(profile);
        if (result?.needsDownload) {
          if (reminderStatus) reminderStatus.textContent = '模型尚未安装，正在下载并校验…';
          result = await window.electronAPI.downloadModel(profile);
        }
        if (!result?.success) throw new Error(result?.error || '模型无法启动。');
        currentModelProfile = result.profile || profile;
        appConfig.computeModePreference = currentModelProfile;
        if (result.firstLowActivation && currentModelProfile === 'low') disableBackgroundForLowMode();
        applyModelProfileUi(currentModelProfile);
        await refreshModelProfiles();
        const enabledName = currentModelProfile === 'low'
          ? 'QWEN 低算力模式'
          : (currentModelProfile === 'wordwise' ? 'QWEN-WordWise' : 'QWEN-Pro');
        showToast(`已启用 ${enabledName}。`, 'success');
        return result;
      } catch (error) {
        if (reminderStatus) reminderStatus.textContent = `启动失败：${error.message}`;
        updateModelStatusUI({ status: 'error', profile, message: error.message });
        showToast(`模型切换失败：${error.message}`, 'error');
        return { success: false, error: error.message };
      } finally {
        isModelOperationRunning = false;
        setModelOperationBusy(false, profile);
      }
    }

    function setModelOperationBusy(busy, profile) {
      for (const id of ['proModeBtn', 'wordwiseModeBtn', 'lowModeBtn', 'acceptLowModeBtn', 'keepProModeBtn', 'selectModelBtn']) {
        const button = document.getElementById(id);
        if (button) button.disabled = busy;
      }
      const targetId = profile === 'low'
        ? 'lowModeBtn'
        : (profile === 'wordwise' ? 'wordwiseModeBtn' : 'proModeBtn');
      const target = document.getElementById(targetId);
      if (busy && target) target.textContent = '⏳ 正在准备…';
      if (!busy) renderModelProfileButtons();
    }

    async function refreshModelProfiles() {
      try {
        modelProfiles = await window.electronAPI.getModelProfiles() || {};
        renderModelProfileButtons();
      } catch (error) {
        console.warn('[AI] profile refresh failed:', error);
      }
    }

    function renderModelProfileButtons() {
      const pro = document.getElementById('proModeBtn');
      const wordwise = document.getElementById('wordwiseModeBtn');
      const low = document.getElementById('lowModeBtn');
      if (pro) pro.textContent = modelProfiles.pro?.installed ? '🚀 启动 QWEN-Pro' : '⬇️ 下载并启动 QWEN-Pro';
      if (wordwise) wordwise.textContent = modelProfiles.wordwise?.installed
        ? '🧠 启动 QWEN-WordWise'
        : '📦 安装并启动 QWEN-WordWise';
      if (low) low.textContent = modelProfiles.low?.installed ? '🌱 启动低算力模式' : '⬇️ 下载并启动低算力模式';
    }

    function disableBackgroundForLowMode() {
      localStorage.setItem('vocab_tester_bg_enabled', 'false');
      document.body.classList.add('bg-disabled');
      const toggle = document.getElementById('bgToggle');
      if (toggle) toggle.checked = false;
    }

    function applyModelProfileUi(profile) {
      const compact = compactModelProfiles.has(profile);
      document.body.classList.toggle('low-compute-mode', compact);
      const lowNote = document.getElementById('lowModeFeatureNote');
      const wordwiseNote = document.getElementById('wordwiseModeFeatureNote');
      if (lowNote) lowNote.style.display = profile === 'low' ? 'block' : 'none';
      if (wordwiseNote) wordwiseNote.style.display = profile === 'wordwise' ? 'block' : 'none';
      resetHints();
    }

    function updateModelStatusUI(data) { // 模型状态 UI
      if (!$modelStatus) return;
      $modelStatus.style.display = 'block';
      const unloadButton = document.getElementById('unloadModelBtn');
      const badge = document.getElementById('modelModeBadge');
      const current = document.getElementById('computeModeCurrent');
      const label = data.displayLabel || data.message || 'AI 模型';
      if (data.profile) currentModelProfile = data.profile;

      if (data.status === 'loading') {
        $modelStatus.style.background = 'rgba(245, 158, 11, 0.15)';
        $modelStatus.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        $modelStatus.style.color = '#d97706';
        $modelStatus.textContent = `⏳ ${data.message || `正在加载 ${label}…`}`;
        if (badge) { badge.textContent = label; badge.className = 'model-mode-badge is-loading'; }
        if (unloadButton) unloadButton.style.display = 'none';
      } else if (data.status === 'ready') {
        $modelStatus.style.background = 'var(--success-bg)';
        $modelStatus.style.borderColor = 'var(--success-border)';
        $modelStatus.style.color = '#059669';
        $modelStatus.textContent = `✅ ${label} 已加载`;
        if (badge) { badge.textContent = label; badge.className = 'model-mode-badge is-ready'; }
        if (current) current.textContent = label;
        if (unloadButton) unloadButton.style.display = 'inline-flex';
        applyModelProfileUi(currentModelProfile);
        refreshModelProfiles();
      } else if (data.status === 'error') {
        $modelStatus.style.background = 'var(--error-bg)';
        $modelStatus.style.borderColor = 'var(--error-border)';
        $modelStatus.style.color = '#dc2626';
        $modelStatus.textContent = `${data.unloaded ? '⏹️' : '❌'} ${data.message || '模型不可用'}`;
        if (badge) {
          badge.textContent = data.unloaded ? 'AI 未加载' : '模型错误';
          badge.className = `model-mode-badge ${data.unloaded ? 'is-idle' : 'is-error'}`;
        }
        if (current && data.unloaded) current.textContent = '尚未加载';
        if (unloadButton) unloadButton.style.display = 'none';
      }
    }

    async function toggleHwAccel() {
      const toggle = document.getElementById('hwAccelToggle');
      if (!toggle) return;
      if (isDemoMode) {
        const visualToggle = document.getElementById('hwAccelToggle_visual');
        toggle.checked = true;
        if (visualToggle) visualToggle.checked = true;
        showToast('硬件加速设置已保存，重新加载模型后生效。', 'success');
        return;
      }
      if (isElectron) {
        await window.electronAPI.updateConfig({ useGpu: toggle.checked });
        showToast('硬件加速设置已保存，重新加载模型后生效。', 'success');
      }
    }

    async function toggleAutoRead() {
      const toggle = document.getElementById('autoReadToggle');
      if (!toggle) return;
      if (isDemoMode) {
        // 演示隔离：不写入真实 config.json
        showToast('演示模式下该设置不可保存', 'info');
        return;
      }
      const checked = toggle.checked;
      appConfig.autoReadWord = checked;
      if (isElectron) {
        try {
          await window.electronAPI.updateConfig({ autoReadWord: checked });
        } catch (err) {
          console.warn('[Config] Failed to save autoReadWord:', err);
        }
      }
      showToast(checked ? '已开启新词自动朗读' : '已关闭新词自动朗读', 'success');
    }

    function toggleBackgroundEffect() {
      const toggle = document.getElementById('bgToggle');
      const isEnabled = toggle.checked;
      if (!isDemoMode) localStorage.setItem('vocab_tester_bg_enabled', isEnabled);

      if (isEnabled) {
        document.body.classList.remove('bg-disabled');
      } else {
        document.body.classList.add('bg-disabled');
      }
    }

    async function unloadModel() {
      invalidateQuestionFlow();
      if (!isElectron) return;
      if (isDemoMode) {
        updateModelStatusUI({
          status: 'ready',
          profile: 'pro', runtimeTier: 'high', displayLabel: 'QWEN-Pro (High)',
        });
        showToast('模型状态已刷新。', 'info');
        return;
      }
      try {
        await window.electronAPI.unloadModel();
        showToast('模型已卸载，内存已释放。', 'info');
      } catch (err) {
        console.error('Failed to unload model:', err);
      }
    }

    async function selectModelFile() {
      invalidateQuestionFlow();
      if (!isElectron) {
        showResult('error-msg', '⚠️ 提示', '请在 Electron 桌面端运行此功能。');
        return;
      }
      if (isDemoMode) {
        updateModelStatusUI({
          status: 'ready',
          profile: 'pro', runtimeTier: 'high', displayLabel: 'QWEN-Pro (High)',
        });
        showToast('模型已加载。', 'success');
        return;
      }
      try {
        const result = await window.electronAPI.selectModelFile();
        if (result && !result.canceled) {
          if (result.success) {
            currentModelProfile = result.profile || 'custom';
            applyModelProfileUi(currentModelProfile);
          } else if (result.error) {
            updateModelStatusUI({ status: 'error', profile: 'custom', message: result.error });
          }
        }
      } catch (err) {
        updateModelStatusUI({ status: 'error', message: err.message });
      }
    }

    async function downloadDefaultModel() {
      return startComputeMode('pro');
    }

    function updateDownloadProgress(data) {
      const $bar = document.getElementById('downloadProgressBar');
      const $text = document.getElementById('downloadProgressText');
      const $pct = document.getElementById('downloadProgressPct');
      const $container = document.getElementById('downloadProgressContainer');
      const reminderStatus = document.getElementById('lowModeReminderStatus');

      if (!$bar || !$text || !$pct || !$container) return;

      $container.style.display = 'block';

      if (data.percent < 0) {
        $bar.style.width = '100%';
        $bar.style.background = 'linear-gradient(90deg, var(--error), #f87171)';
        $text.textContent = data.message;
        $pct.textContent = '❌';
        if (reminderStatus) reminderStatus.textContent = data.message;
      } else if (data.percent >= 100) {
        $bar.style.width = '100%';
        $text.textContent = data.message;
        $pct.textContent = '100%';
        if (reminderStatus) reminderStatus.textContent = data.message;
        setTimeout(() => { $container.style.display = 'none'; }, 3000);
      } else {
        $bar.style.width = data.percent + '%';
        $bar.style.background = 'linear-gradient(90deg, var(--accent), #d8b4fe)';
        $text.textContent = `${data.receivedMB} MB / ${data.totalMB} MB`;
        $pct.textContent = data.percent + '%';
        if (reminderStatus) {
          reminderStatus.textContent = `${data.displayName || '模型'}：${data.receivedMB} MB / ${data.totalMB} MB`;
        }
      }
    }



        function renderWordList() { // 词表管理
      $wordCount.textContent = `共 ${words.length} 个单词`;

      const RENDER_LIMIT = 300; // 列表太长只渲染前300个
      const displayWords = words.length > RENDER_LIMIT ? words.slice(0, RENDER_LIMIT) : words;

      let html = displayWords.map((w, i) => {
        const dbW = wordMap.get(w.toLowerCase());
        const tooltip = dbW && dbW.meaning ? dbW.meaning : w;
        return `
    <span class="word-tag" title="${escapeHtml(tooltip)}">
      ${escapeHtml(w)}
      <button class="delete-btn" onclick="deleteWord(${i})" title="删除">×</button>
    </span>
  `}).join("");

      if (words.length > RENDER_LIMIT) {
        html += `<div style="width:100%; text-align:center; padding: 10px; color: var(--text-muted); font-size: 0.9rem;">
      仅显示前 ${RENDER_LIMIT} 个单词...
    </div>`;
      }

      $wordList.innerHTML = html;
    }

    async function addWord() {
      const $inp = $newWordInput;
      const raw = $inp.value.trim();
      let term, meaning, rest;
      if (raw.includes(':') || raw.includes('：')) {
        const sep = raw.includes('：') ? '：' : ':';
        [term, ...rest] = raw.split(sep);
        term = term.trim();
        meaning = rest.join(sep).trim();
      } else {
        term = raw.toLowerCase();
        meaning = '(见AI解析)';
      }
      if (!term) return;

      const termLower = term.toLowerCase();
      if (wordSet.has(termLower)) {
        $inp.value = '';
        $inp.placeholder = '该单词已存在！';
        setTimeout(() => $inp.placeholder = '输入新单词（英文）…', 1500);
        return;
      }

      if (isDemoMode) {
        const newWord = {
          id: Date.now(),
          term,
          meaning: meaning || '(释义待补充)',
        };
        wordsDb.push(newWord);
        words.push(newWord.term);
        wordMap.set(termLower, newWord);
        wordSet.add(termLower);
        demoScenario.words = wordsDb;
        demoScenario.totalWords += 1;
        epochPool.push(newWord.term);
        renderWordList();
        $wordCount.textContent = `共 ${demoScenario.totalWords} 个单词`;
        showToast('单词已添加。', 'success');
      } else if (isElectron) {
        const newWord = await window.electronAPI.db.addWord(term, meaning);
        if (newWord) {
          const termLower = newWord.term.toLowerCase();
          const PHONETIC_REGEX = /\[.*?\]|\/.*?\//;
          const match = newWord.meaning.match(PHONETIC_REGEX);
          if (match) newWord.phonetic = match[0];

          wordsDb.push(newWord);
          words.push(newWord.term);
          wordMap.set(termLower, newWord);
          wordSet.add(termLower);

          epochPool.push(newWord.term);
          epochTotal = words.length;
          renderWordList();
          updateProgressBar();
        } else {
          showResult('error-msg', '⚠️ 添加失败', '可能是因为单词已存在或数据库错误');
        }
      } else {
        words.push(term);
        syncWordSet();
        epochPool.push(term);
        epochTotal = words.length;
        renderWordList();
        updateProgressBar();
      }
      $inp.value = '';
    }

    async function deleteWord(index) {
      const removed = words[index];
      if (!removed) return;
      const removedLower = removed.toLowerCase();

      if (isElectron && !isDemoMode) {
        const dbWord = wordMap.get(removedLower);
        if (dbWord) {
          await window.electronAPI.db.deleteWord(dbWord.id);
          wordsDb = wordsDb.filter(w => w.id !== dbWord.id);
          wordMap.delete(removedLower);
        }
      }

      words.splice(index, 1);
      wordsDb = wordsDb.filter(word => word.term.toLowerCase() !== removedLower);
      wordSet.delete(removedLower);
      wordMap.delete(removedLower);

      if (isDemoMode) {
        demoScenario.words = wordsDb;
        demoScenario.totalWords = Math.max(words.length, demoScenario.totalWords - 1);
      }

      const poolIdx = epochPool.indexOf(removed);
      if (poolIdx !== -1) epochPool.splice(poolIdx, 1);
      epochTotal = words.length;

      if (sequentialIndex >= words.length) sequentialIndex = 0;
      if (currentWord === removed) {
        currentWord = null;
        currentWordIdx = -1;
        $currentWord.textContent = '点击按钮抽取单词';
        $currentWord.className = 'word-placeholder';
        $wordIndex.textContent = '';
      }
      renderWordList();
      if (isDemoMode) $wordCount.textContent = `共 ${demoScenario.totalWords} 个单词`;
      updateProgressBar();
    }

    async function requestNextQuestion(source = 'manual') {
      if (advanceInFlight) return;
      advanceInFlight = true;
      const token = ++questionGenerationToken;
      clearAutoAdvance();
      const nextButton = document.getElementById('nextBtn');
      if (nextButton) nextButton.disabled = true;
      try {
        if (mistakeReviewActive) {
          await pickNextMistake(token);
        } else if (quizMode === 'adaptive') {
          await pickNextWordAdaptive(token);
        } else {
          pickNextWord();
        }
      } finally {
        if (token === questionGenerationToken) {
          advanceInFlight = false;
          if (nextButton) nextButton.disabled = false;
        }
      }
    }

    function invalidateQuestionFlow() {
      questionGenerationToken++;
      advanceInFlight = false;
      clearAutoAdvance();
      const nextButton = document.getElementById('nextBtn');
      if (nextButton) nextButton.disabled = false;
      if ($checkBtn) {
        $checkBtn.disabled = false;
        $checkBtn.textContent = '✨ AI 深度判卷';
      }
    }

    async function enterMistakeReview() {
      if (!isElectron || isDemoMode) {
        showToast('错题复习仅在真实学习模式中可用。', 'warning');
        return;
      }
      invalidateQuestionFlow();
      mistakeReviewActive = true;
      currentMistake = null;
      lastDisplayedMistakeId = null;
      document.getElementById('mistakeReviewBtn')?.classList.add('active');
      await requestNextQuestion('mistake_review_entry');
    }

    async function toggleMistakeReview() {
      if (mistakeReviewActive) await exitMistakeReview();
      else await enterMistakeReview();
    }

    async function exitMistakeReview() {
      if (!mistakeReviewActive) return;
      invalidateQuestionFlow();
      mistakeReviewActive = false;
      currentMistake = null;
      lastDisplayedMistakeId = null;
      document.getElementById('mistakeReviewBtn')?.classList.remove('active');
      await requestNextQuestion('mistake_review_exit');
    }

    async function pickNextMistake(token) {
      resetHints();
      hideScoreRing();
      isFirstAttempt = false;
      const next = await window.electronAPI.db.getNextMistake({
        excludeMistakeId: lastDisplayedMistakeId,
      });
      if (token !== questionGenerationToken || !mistakeReviewActive) return;
      if (!next) {
        currentMistake = null;
        currentWord = null;
        currentWordObj = null;
        $currentWord.textContent = '当前没有其他可复习的错题';
        $currentWord.className = 'word-placeholder';
        $wordIndex.textContent = '错题可能已完成，或正在 15 分钟冷却中';
        $epochLabel.textContent = '错题复习';
        $answerInput.value = '';
        hideResult();
        const status = await refreshMistakeQueueStatus();
        if (status?.nextEligibleAt) {
          const nextTime = new Date(status.nextEligibleAt);
          if (!Number.isNaN(nextTime.getTime())) {
            $wordIndex.textContent = `最早可复习时间：${nextTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
        }
        return;
      }
      currentMistake = next;
      lastDisplayedMistakeId = next.mistakeId;
      currentWord = next.term;
      currentWordObj = {
        id: next.wordId,
        term: next.term,
        meaning: next.meaning,
      };
      currentWordIdx = -1;
      displayCurrentWord();
      $answerInput.value = '';
      hideResult();
      $wordIndex.textContent = `错题复习 · 上次回答：${next.answerText || '（空）'}`;
      $epochLabel.textContent = `优先级 ${Math.round(next.priorityScore)} · 错 ${next.wrongCount} 次`;
      document.getElementById('reviewTag')?.classList.add('show');
      answerStartTime = performance.now();
      $answerInput.focus();
    }

    async function refreshMistakeQueueStatus() {
      if (!isElectron || isDemoMode) return null;
      try {
        const status = await window.electronAPI.db.getMistakeQueueStatus();
        const badge = document.getElementById('mistakeDueBadge');
        if (badge) {
          const due = Number(status?.dueCount || 0);
          badge.textContent = due > 99 ? '99+' : String(due);
          badge.hidden = due <= 0;
        }
        return status;
      } catch (error) {
        console.warn('[MistakeQueue] status:', error);
        return null;
      }
    }

        function pickNextWord() { // 取词（随机/顺序/自适应）
      if (isDemoMode) {
        renderDemoScene();
        $answerInput.focus();
        return;
      }
      if (words.length === 0) {
        $currentWord.textContent = "词汇表为空，请先添加单词";
        $currentWord.className = "word-placeholder";
        $wordIndex.textContent = "";
        return;
      }

      clearAutoAdvance();
      resetHints();
      hideScoreRing();
      isFirstAttempt = true;

      if (epochPool.length === 0) {
        epochNumber++;
        initEpoch();
      }

      let word = epochPool.shift();
      currentWord = word;
      currentWordObj = wordMap.get(word.toLowerCase()) || null;

      currentWordIdx = words.indexOf(word);

      if (quizMode === "sequential") {
        sequentialIndex = (currentWordIdx + 1) % words.length;
      }

      displayCurrentWord();
      $answerInput.value = "";
      hideResult();
      $answerInput.focus();
      updateProgressBar();
      answerStartTime = performance.now(); // 开始计时
    }

    async function pickNextWordAdaptive(expectedToken = questionGenerationToken) {
      if (isDemoMode) {
        renderDemoScene();
        $answerInput.focus();
        return;
      }
      if (words.length === 0) {
        $currentWord.textContent = "词汇表为空，请先添加单词";
        $currentWord.className = "word-placeholder";
        return;
      }

      clearAutoAdvance();
      resetHints();
      hideScoreRing();
      isFirstAttempt = true;

      try {
        const excludeId = currentWordObj ? currentWordObj.id : null;
        const nextWord = await window.electronAPI.db.getNextAdaptive(currentDifficulty, excludeId);
        if (expectedToken !== questionGenerationToken || mistakeReviewActive) return;
        if (!nextWord) {
          $currentWord.textContent = "没有更多单词了";
          $currentWord.className = "word-placeholder";
          return;
        }

        currentWord = nextWord.term;
        currentWordObj = nextWord;
        currentWordIdx = words.indexOf(currentWord);
        adaptiveWordsCompleted++;

        const reviewTag = document.getElementById('reviewTag');
        if (reviewTag) {
          reviewTag.classList.toggle('show', !!nextWord.isReview);
        }

        updateMasteryMeter(nextWord.masteryScore || 0);
        updateDifficultyUI(nextWord.difficultyLevel || currentDifficulty);

        displayCurrentWord();
        $answerInput.value = "";
        hideResult();
        $answerInput.focus();
        answerStartTime = performance.now(); // 开始计时

        $epochCount.textContent = `自适应 · 已完成 ${adaptiveWordsCompleted} 词`;
        $epochLabel.textContent = selectionReasonLabel(nextWord.selectionReason);
      } catch (err) {
        console.error('[Adaptive] Failed to get next word:', err);
        showToast('自适应选词失败，回退到随机模式', 'warning');
        setMode('random');
        requestNextQuestion('adaptive_fallback');
      }
    }

    function displayCurrentWord() {
      let phoneticHtml = '';
      const dbW = wordMap.get(currentWord.toLowerCase());
      if (dbW && dbW.phonetic) {
        phoneticHtml = `<div style="font-size: 0.6em; color: var(--text-secondary); margin-top: 8px; font-weight: normal; letter-spacing: 1px;">${escapeHtml(dbW.phonetic)}</div>`;
      }

      const audioBtn = `<span id="playAudioBtn" onclick="playWordAudio()" style="cursor:pointer;margin-left:10px;font-size:0.7em;vertical-align:middle;opacity:0.6;transition:opacity 0.2s;" title="朗读单词" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">🔊</span>`;

      $currentWord.innerHTML = `${escapeHtml(currentWord)}${phoneticHtml}${audioBtn}`;
      $currentWord.className = "current-word";
      $wordIndex.textContent = currentWordIdx >= 0 ? `第 ${currentWordIdx + 1} / ${words.length} 个` : '';

      // 新词自动朗读（开关开启且非演示模式时生效；isElectron 守卫在 playWordAudio 内部）
      if (appConfig.autoReadWord && !isDemoMode) {
        playWordAudio({ silent: true });
      }
    }

    let currentAudio = null;
    let audioPlayToken = 0; // 播放令牌：快速切词时作废旧请求，防止读错词
    let currentUtterance = null; // 保留 utterance 引用，避免被 GC 导致静默（Chromium 已知问题）
    async function playWordAudio(options = {}) {
      const { silent = false } = options;
      if (!currentWord || !isElectron) return;
      const word = currentWord; // 捕获当前词，避免 await 期间切词/删词后读错词
      const token = ++audioPlayToken;
      try {
        // 播放前停止残留音频与系统朗读
        if (currentAudio) {
          currentAudio.pause();
          currentAudio = null;
        }
        try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (_) {}

        const audioUrl = await window.electronAPI.getAudioPath(word);
        if (token !== audioPlayToken) return; // 已切换到新词，丢弃过期播放
        if (audioUrl) {
          // audioUrl is now a media://audio/<word> protocol URL served from SQLite
          currentAudio = new Audio(audioUrl);
          currentAudio.playbackRate = 1.0;
          await currentAudio.play();
        } else if (word === currentWord) {
          // 本地无音频文件时用系统 TTS 兜底（静默/非静默都走兜底）；词已被切换/删除则不朗读
          try {
            if (token === audioPlayToken && typeof speechSynthesis !== 'undefined') {
              currentUtterance = new SpeechSynthesisUtterance(word);
              currentUtterance.lang = 'en-US';
              currentUtterance.rate = 0.9;
              speechSynthesis.speak(currentUtterance);
            }
          } catch (fbErr) {
            console.warn('[Audio] speechSynthesis fallback failed:', fbErr);
            if (!silent) showToast('语音播放失败', 'error');
          }
        }
      } catch (err) {
        // 快速连续调用时旧 play() 被 pause() 打断会以 AbortError reject，属正常抢占，不弹提示
        if (err?.name === 'AbortError') return;
        console.warn('[Audio] playback error:', err);
        if (!silent) showToast('语音播放失败', 'error');
      }
    }

    async function checkAnswer() {
      if (licenseState && licenseState.status === 'expired') { showLicenseLock(); return; }
      if (!currentWord) {
        showResult("error-msg", "⚠️ 提示", "请先点击「下一个」选择一个单词。");
        return;
      }

      const answer = $answerInput.value.trim();
      if (!answer) {
        showResult("error-msg", "⚠️ 提示", "请输入你的中文翻译。");
        return;
      }

      if (isDemoMode) {
        evaluateDemoAnswer(answer);
        return;
      }

      invalidateQuestionFlow();
      const evaluationToken = questionGenerationToken;

      $loading.classList.add("show");
      $checkBtn.disabled = true;
      $checkBtn.textContent = "⏳ 评估中…";
      hideResult();
      hideScoreRing();

      const hintSec = document.querySelector('.hints-stack');
      if (hintSec) hintSec.style.display = 'none';
      const hintContainer = document.getElementById('hintResultContainer');
      if (hintContainer) hintContainer.style.display = 'none';

      try {
        if (!isElectron) {
          throw new Error("请在 Electron 桌面端运行此应用以使用 AI 检查功能。");
        }

        const elapsedMs = answerStartTime > 0 ? Math.round(performance.now() - answerStartTime) : 0;
        const attemptContext = mistakeReviewActive && currentMistake
          ? { source: 'mistake_review', mistakeId: currentMistake.mistakeId }
          : { source: 'practice' };
        const rawResponse = await window.electronAPI.checkAnswer(
          currentWord,
          answer,
          elapsedMs,
          attemptContext
        );
        if (evaluationToken !== questionGenerationToken) return;

        const result = rawResponse;
        if (result?.perf_tier) {
          console.log(`[Perf] answer latency=${result.latency_ms}ms tier=${result.perf_tier}`);
        }
        if (!result || result.evaluation_status !== 'ok') {
          const message = result?.explanation || '评估结果无法验证，本次不会计分。';
          showResult('error-msg', '⚠️ 未计分', message);
          restoreHintAreaAfterFailure();
          return;
        }

        const score = Number(result.score);
        if (!Number.isInteger(score) || score < 0 || score > 100) {
          showResult('error-msg', '⚠️ 未计分', '评估分数无效，本次不会计分。');
          restoreHintAreaAfterFailure();
          return;
        }
        const isCorrect = score >= 60;
        const explanation = result.explanation || (isCorrect ? "回答正确！" : "回答有误。");
        const masteryScore = result.mastery_score;
        const difficultyDelta = result.difficulty_delta || 0;
        const pathLabel = evaluationPathLabel(result.evaluation_path);

        if (isCorrect) {
          if (result.reward_eligible === true && isFirstAttempt) {
            currentScore += 10;
            localStorage.setItem(SCORE_KEY, currentScore);
            updateScoreUI();
            showToast("🌟 回答正确，+10 积分！", "success");
            isFirstAttempt = false;
          }

          showResult("correct", "✅ 正确！", explanation, pathLabel);
          disableHintsOnCorrect();
          startAutoAdvance();
        } else {
          isFirstAttempt = false;
          showResult("incorrect", "❌ 不正确", explanation, pathLabel);
        }

        if (mistakeReviewActive) {
          refreshMistakeQueueStatus();
          if (isCorrect) showToast('该错题已完成复习，不计入积分。', 'success');
        } else if (!isCorrect) {
          refreshMistakeQueueStatus();
        }

        const isStubbornWord = !!result.is_stubborn;
        if (isStubbornWord) {
          showStubbornBadge();
        } else {
          hideStubbornBadge();
        }

        const confusionHint = result.confusion_hint || '';
        if (confusionHint) {
          showConfusionAlert(confusionHint);
        }
        if (result.confusion_update?.is_visible) {
          showToast(`已更新个人易混图 · 风险 ${Math.round(result.confusion_update.risk_score)} 分`, 'warning');
        }

        showScoreRing(score);

        if (masteryScore !== null && masteryScore !== undefined) {
          updateMasteryMeter(masteryScore);
        }

        if (quizMode === 'adaptive' && difficultyDelta !== 0) {
          const newDiff = Math.max(1, Math.min(10, currentDifficulty + difficultyDelta));
          if (newDiff !== currentDifficulty) {
            currentDifficulty = newDiff;
            localStorage.setItem(DIFFICULTY_KEY, currentDifficulty);
            updateDifficultyUI(currentDifficulty);

            if (currentWordObj && currentWordObj.id) {
              window.electronAPI.db.updateDifficulty(currentWordObj.id, newDiff).catch(e =>
                console.warn('[Adaptive] Failed to sync difficulty to DB:', e)
              );
            }

            const diffBadge = document.getElementById('difficultyBadge');
            if (diffBadge) {
              diffBadge.classList.remove('diff-up', 'diff-down');
              diffBadge.classList.add(difficultyDelta > 0 ? 'diff-up' : 'diff-down');
              setTimeout(() => diffBadge.classList.remove('diff-up', 'diff-down'), 2000);
            }

            const arrow = difficultyDelta > 0 ? '⬆️' : '⬇️';
            showToast(`${arrow} 难度调整: ${currentDifficulty}`, difficultyDelta > 0 ? 'success' : 'warning');
          }
        }

      } catch (err) {
        let message = err.message;
        if (message.includes('Model not loaded')) {
          message = "模型未加载。\n\n请先点击「选择 GGUF 模型文件」加载一个模型。";
        }
        showResult("error-msg", "⚠️ 错误", message);
        restoreHintAreaAfterFailure();
      } finally {
        if (evaluationToken === questionGenerationToken) {
          $loading.classList.remove("show");
          $checkBtn.disabled = false;
          $checkBtn.textContent = "✨ AI 深度判卷";
        }
      }
    }

    function evaluateDemoAnswer(answer) {
      const accepted = String(demoScenario?.answer || '')
        .split(/[；;，,、]/)
        .map(item => item.trim())
        .filter(Boolean);
      const normalized = String(answer).trim();
      const isCorrect = accepted.some(item => normalized.includes(item));
      const score = isCorrect ? 96 : 42;

      clearAutoAdvance();
      hideResult();
      hideScoreRing();
      const hintSection = document.querySelector('.hints-stack');
      if (hintSection) hintSection.style.display = 'none';
      const hintResult = document.getElementById('hintResultContainer');
      if (hintResult) hintResult.style.display = 'none';

      if (isCorrect) {
        if (isFirstAttempt) currentScore += 10;
        isFirstAttempt = false;
        updateScoreUI();
        hideStubbornBadge();
        const confusionAlert = document.getElementById('confusionAlertBox');
        if (confusionAlert) confusionAlert.style.display = 'none';
        showResult('correct', '✅ 正确！', '回答准确，已覆盖该词的核心释义。', '紧凑语义评估');
        showToast('🌟 回答正确，+10 积分！', 'success');
      } else {
        isFirstAttempt = false;
        showResult(
          'incorrect',
          '❌ 不正确',
          `你的回答没有覆盖“${demoScenario.answer}”这一标准释义。`,
          '边界语义复核'
        );
        showStubbornBadge();
        showConfusionAlert('检测到重复误答模式，已提高该词的复习优先级。');
      }
      showScoreRing(score);
      updateMasteryMeter(isCorrect
        ? Math.min(100, demoScenario.mastery + 8)
        : Math.max(0, demoScenario.mastery - 6));
    }

    function restoreHintAreaAfterFailure() {
      const hintSection = document.querySelector('.hints-stack');
      const hintResult = document.getElementById('hintResultContainer');
      if (hintSection) hintSection.style.display = 'flex';
      if (hintResult) hintResult.style.display = 'block';
    }

    function evaluationPathLabel(path) {
      return {
        literal_fast_path: '本地快速判定',
        cached_semantic_result: '复用已验证结果',
        compact_semantic_eval: '紧凑语义评估',
        boundary_semantic_review: '边界语义复核',
        low_compute_quality_gate: '低算力质量复核',
      }[path] || '';
    }

    function showResult(type, label, text, pathLabel = '') {
      $resultBox.className = `result-box show ${type}`;
      const path = pathLabel
        ? `<span class="evaluation-path">${escapeHtml(pathLabel)}</span>`
        : '';
      $resultBox.innerHTML = `<div class="result-label">${label}${path}</div><div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
      $resultBox.style.animation = "none";
      $resultBox.offsetHeight;
      $resultBox.style.animation = "";
    }

    function hideResult() {
      $resultBox.className = "result-box";
      $resultBox.innerHTML = "";
    }

    function renderResultAdvanceControls(state, remainingMs = 0) {
      document.getElementById('autoAdvanceControls')?.remove();
      const controls = document.createElement('div');
      controls.id = 'autoAdvanceControls';
      controls.className = 'auto-advance-controls';
      if (state === 'timed') {
        controls.innerHTML = `
          <span id="autoAdvanceCountdown">⏩ ${(remainingMs / 1000).toFixed(1)} 秒后进入下一题</span>
          <button type="button" class="result-action secondary" onclick="pauseAutoAdvance()">⏸ 暂停</button>
          <button type="button" class="result-action" onclick="requestNextQuestion('result_next')">立即下一题</button>`;
      } else if (state === 'paused') {
        controls.innerHTML = `
          <span>已暂停</span>
          <button type="button" class="result-action" onclick="requestNextQuestion('result_next')">立即下一题</button>`;
      } else {
        controls.innerHTML = `
          <button type="button" class="result-action" onclick="requestNextQuestion('result_next')">下一题</button>`;
      }
      $resultBox.appendChild(controls);
    }

        function startAutoAdvance() { // 自动翻页
      clearAutoAdvance();
      if (appConfig.autoAdvanceEnabled === false) {
        renderResultAdvanceControls('manual');
        return;
      }
      const delay = [1500, 3000, 5000, 8000].includes(appConfig.autoAdvanceDelayMs)
        ? appConfig.autoAdvanceDelayMs
        : 1500;
      const deadline = performance.now() + delay;
      renderResultAdvanceControls('timed', delay);
      autoAdvanceInterval = setInterval(() => {
        const remaining = Math.max(0, deadline - performance.now());
        const label = document.getElementById('autoAdvanceCountdown');
        if (label) label.textContent = `⏩ ${(remaining / 1000).toFixed(1)} 秒后进入下一题`;
      }, 100);
      autoAdvanceTimer = setTimeout(() => requestNextQuestion('timer'), delay);
    }

    function pauseAutoAdvance() {
      if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
      if (autoAdvanceInterval) clearInterval(autoAdvanceInterval);
      autoAdvanceTimer = null;
      autoAdvanceInterval = null;
      renderResultAdvanceControls('paused');
    }

    function clearAutoAdvance() {
      if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
      }
      if (autoAdvanceInterval) {
        clearInterval(autoAdvanceInterval);
        autoAdvanceInterval = null;
      }
      document.getElementById('autoAdvanceControls')?.remove();
    }

    function syncAutoAdvanceSettings() {
      const toggle = document.getElementById('autoAdvanceToggle');
      const preset = document.getElementById('autoAdvanceDelaySelect');
      if (toggle) toggle.checked = appConfig.autoAdvanceEnabled !== false;
      if (preset) {
        preset.value = String(appConfig.autoAdvanceDelayMs || 1500);
        preset.disabled = appConfig.autoAdvanceEnabled === false;
      }
      const state = document.getElementById('autoAdvanceSettingState');
      if (state) {
        state.textContent = appConfig.autoAdvanceEnabled === false
          ? '手动'
          : `${(appConfig.autoAdvanceDelayMs / 1000).toFixed(1)} 秒`;
      }
    }

    async function updateAutoAdvanceSettings() {
      const toggle = document.getElementById('autoAdvanceToggle');
      const preset = document.getElementById('autoAdvanceDelaySelect');
      appConfig.autoAdvanceEnabled = toggle?.checked !== false;
      const delay = Number(preset?.value);
      if ([1500, 3000, 5000, 8000].includes(delay)) appConfig.autoAdvanceDelayMs = delay;
      syncAutoAdvanceSettings();
      if (isElectron && !isDemoMode) {
        await window.electronAPI.updateConfig({
          autoAdvanceEnabled: appConfig.autoAdvanceEnabled,
          autoAdvanceDelayMs: appConfig.autoAdvanceDelayMs,
        });
      }
    }

        function openGuideModal() { // 弹窗控制
      invalidateQuestionFlow();
      document.getElementById('guideModalOverlay').classList.add('active');
    }
    function closeGuideModal() {
      invalidateQuestionFlow();
      document.getElementById('guideModalOverlay').classList.remove('active');
    }
    function openSettingsModal() {
      invalidateQuestionFlow();
      const overlay = document.getElementById('settingsModalOverlay');
      if (overlay) {
        overlay.style.display = '';
        overlay.classList.add('active');
      }
      if (isElectron && !isDemoMode) refreshModelProfiles();
    }
    function closeSettingsModal() {
      invalidateQuestionFlow();
      const overlay = document.getElementById('settingsModalOverlay');
      if (overlay) {
        overlay.classList.remove('active');
        overlay.style.display = '';
      }
    }

    function openConfusionMapModal() {
      invalidateQuestionFlow();
      document.getElementById('confusionMapModalOverlay').classList.add('active');
      loadConfusionMap();
    }

    function closeConfusionMapModal() {
      invalidateQuestionFlow();
      document.getElementById('confusionMapModalOverlay').classList.remove('active');
    }

    async function loadConfusionMap() {
      const status = document.getElementById('confusionMapStatus');
      const graph = document.getElementById('confusionMapGraph');
      const detail = document.getElementById('confusionMapDetail');
      if (!status || !graph || !detail) return;

      if (isDemoMode) {
        confusionMapEdges = window.WordWiseDemo.getConfusionMap();
        renderConfusionMap();
        const firstVisible = confusionMapEdges.find(edge =>
          Number(edge.riskScore || 0) >= Number(document.getElementById('confusionRiskFilter')?.value || 0)
        );
        if (firstVisible) showConfusionDetail(firstVisible);
        return;
      }

      if (!isElectron) {
        status.textContent = '个人易混图仅在 Electron 桌面端可用。';
        graph.innerHTML = '';
        return;
      }

      status.textContent = '正在读取本地学习记录…';
      graph.innerHTML = '';
      detail.className = 'confusion-map-detail is-empty';
      detail.textContent = '选择图中的关系，查看错误释义、风险构成和练习入口。';

      try {
        confusionMapEdges = await window.electronAPI.db.getConfusionMap(20);
        renderConfusionMap();
      } catch (error) {
        console.error('[ConfusionMap] load failed:', error);
        status.textContent = '读取易混图失败，请稍后重试。';
      }
    }

    function renderConfusionMap() {
      const status = document.getElementById('confusionMapStatus');
      const graph = document.getElementById('confusionMapGraph');
      const filter = document.getElementById('confusionRiskFilter');
      const detail = document.getElementById('confusionMapDetail');
      if (!status || !graph) return;

      const minimumRisk = Number(filter?.value || 0);
      const edges = confusionMapEdges.filter(edge => Number(edge.riskScore || 0) >= minimumRisk);
      if (edges.length === 0) {
        status.textContent = confusionMapEdges.length
          ? '没有符合当前风险筛选条件的关系。'
          : '还没有可展示的易混关系。重复出现同一错误释义两次后，系统会在这里显示它。';
        graph.innerHTML = '';
        if (detail) {
          detail.className = 'confusion-map-detail is-empty';
          detail.textContent = '选择图中的关系，查看错误释义、风险构成和练习入口。';
        }
        return;
      }

      const sourceIndex = new Map();
      edges.forEach(edge => {
        if (!sourceIndex.has(edge.sourceWordId)) sourceIndex.set(edge.sourceWordId, sourceIndex.size);
      });

      const width = 760;
      const height = isDemoMode ? 230 : Math.max(340, edges.length * 74 + 56);
      const sourceY = index => 46 + (index + 0.5) * ((height - 92) / sourceIndex.size);
      const evidenceY = index => 54 + index * ((height - 108) / Math.max(edges.length - 1, 1));
      const label = (value, limit = 17) => {
        const text = String(value || '未定位错误释义');
        return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
      };

      let svg = `<svg class="confusion-map-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="个人易混图">`;
      svg += '<text class="confusion-map-column-title" x="78" y="28">被测单词</text>';
      svg += '<text class="confusion-map-column-title" x="528" y="28">错误释义 / 候选词</text>';

      edges.forEach((edge, index) => {
        const sourceYValue = sourceY(sourceIndex.get(edge.sourceWordId));
        const evidenceYValue = evidenceY(index);
        const confirmed = Boolean(edge.isConfirmed);
        const widthValue = Math.min(9, 2 + Number(edge.occurrenceCount || 0));
        svg += `<line class="confusion-map-edge ${confirmed ? 'confirmed' : 'evidence'}" data-edge-index="${index}" x1="214" y1="${sourceYValue}" x2="530" y2="${evidenceYValue}" stroke-width="${widthValue}"></line>`;
      });

      [...sourceIndex.entries()].forEach(([sourceWordId, index]) => {
        const edge = edges.find(item => item.sourceWordId === sourceWordId);
        const y = sourceY(index);
        svg += `<g class="confusion-map-node source" data-edge-index="${edges.indexOf(edge)}"><circle cx="204" cy="${y}" r="${Math.min(28, 16 + Number(edge.riskScore || 0) / 12)}"></circle><text x="194" y="${y + 5}" text-anchor="end">${escapeHtml(label(edge.sourceTerm))}</text></g>`;
      });

      edges.forEach((edge, index) => {
        const y = evidenceY(index);
        const confirmed = Boolean(edge.isConfirmed);
        const term = confirmed ? edge.candidateTerm : edge.answerText;
        svg += `<g class="confusion-map-node ${confirmed ? 'confirmed' : 'evidence'}" data-edge-index="${index}"><circle cx="544" cy="${y}" r="${confirmed ? 18 : 15}"></circle><text x="572" y="${y + 5}">${escapeHtml(label(term))}</text></g>`;
      });

      svg += '</svg>';
      graph.innerHTML = svg;
      graph.querySelectorAll('[data-edge-index]').forEach(node => {
        node.addEventListener('click', () => showConfusionDetail(edges[Number(node.dataset.edgeIndex)]));
      });
      status.textContent = `已显示 ${edges.length} 条本地易混关系。点击节点或连线查看详情。`;
    }

    async function showConfusionDetail(edge) {
      const detail = document.getElementById('confusionMapDetail');
      if (!detail || !edge) return;

      detail.className = 'confusion-map-detail';
      detail.textContent = '正在读取关系详情…';
      let item = edge;
      if (isDemoMode) {
        item = window.WordWiseDemo.getConfusionDetail(edge.sourceWordId, edge.answerFingerprint) || edge;
      } else if (isElectron) {
        try {
          item = await window.electronAPI.db.getConfusionDetail(edge.sourceWordId, edge.answerFingerprint) || edge;
        } catch (error) {
          console.warn('[ConfusionMap] detail fallback:', error);
        }
      }

      const candidate = item.candidateTerm
        ? `${escapeHtml(item.candidateTerm)} · ${escapeHtml(item.candidateMeaning || '')}`
        : '尚未定位到足够可靠的候选词';
      const responseTime = item.averageResponseTimeMs > 0
        ? `${(item.averageResponseTimeMs / 1000).toFixed(1)} 秒`
        : '未计时';
      detail.innerHTML = `
        <div class="confusion-detail-header">
          <div><span class="confusion-detail-kicker">重复误答关系</span><h3>${escapeHtml(item.sourceTerm)}</h3></div>
          <strong>风险 ${Math.round(item.riskScore)} 分</strong>
        </div>
        <dl class="confusion-detail-list">
          <div><dt>标准释义</dt><dd>${escapeHtml(item.sourceMeaning)}</dd></div>
          <div><dt>重复填写</dt><dd>${escapeHtml(item.answerText)}</dd></div>
          <div><dt>候选关联</dt><dd>${candidate}</dd></div>
          <div><dt>风险依据</dt><dd>重复 ${item.occurrenceCount} 次 · 平均得分 ${Math.round(item.averageScore)} 分 · 平均作答 ${responseTime}</dd></div>
          <div><dt>最近记录</dt><dd>${escapeHtml(item.lastSeen)}</dd></div>
        </dl>
        <button class="btn-small confusion-practice-btn" id="practiceConfusionWordBtn">练习这个词</button>`;
      document.getElementById('practiceConfusionWordBtn')?.addEventListener('click', () => practiceConfusionWord(item));
    }

    function practiceConfusionWord(item) {
      invalidateQuestionFlow();
      mistakeReviewActive = false;
      currentMistake = null;
      lastDisplayedMistakeId = null;
      document.getElementById('mistakeReviewBtn')?.classList.remove('active');
      resetHints();
      hideScoreRing();
      isFirstAttempt = true;
      currentWord = item.sourceTerm;
      currentWordObj = wordMap.get(currentWord.toLowerCase()) || {
        id: item.sourceWordId,
        term: item.sourceTerm,
        meaning: item.sourceMeaning,
      };
      currentWordIdx = words.indexOf(currentWord);
      displayCurrentWord();
      $answerInput.value = '';
      hideResult();
      answerStartTime = performance.now();
      $wordIndex.textContent = '个人易混图练习';
      $epochLabel.textContent = '易混词练习';
      closeConfusionMapModal();
      $answerInput.focus();
      showToast(`已开始练习：${currentWord}`, 'info');
    }

    function selectionReasonLabel(reason) {
      const labels = {
        due_review: '到期复习',
        confusion_risk: '易混词优先',
        stubborn_word: '顽固词优先',
        difficulty_match: '难度匹配',
        fallback: '随机补充',
      };
      return labels[reason] || `难度 ${currentDifficulty}`;
    }
        function setMode(mode) { // 模式切换
      const wasMistakeReview = mistakeReviewActive;
      invalidateQuestionFlow();
      mistakeReviewActive = false;
      currentMistake = null;
      lastDisplayedMistakeId = null;
      document.getElementById('mistakeReviewBtn')?.classList.remove('active');
      if (quizMode === mode) {
        if (wasMistakeReview) requestNextQuestion('mode_exit_review');
        return;
      }
      quizMode = mode;
      if (!isDemoMode) localStorage.setItem("vocab_tester_mode", mode);
      updateModeToggleUI();

      if (isDemoMode) {
        renderDemoScene();
        return;
      }

      if (mode === 'adaptive') {
        adaptiveWordsCompleted = 0;
                const meter = document.getElementById('masteryMeter'); // 显示自适应 UI
        if (meter) meter.classList.add('show');
        updateDifficultyUI(currentDifficulty);
      } else {
                const meter = document.getElementById('masteryMeter'); // 隐藏自适应 UI
        if (meter) meter.classList.remove('show');
        const reviewTag = document.getElementById('reviewTag');
        if (reviewTag) reviewTag.classList.remove('show');
        epochNumber = 1;
        sequentialIndex = 0;
        initEpoch();
      }
    }

    function updateModeToggleUI() {
      $modeRandomBtn.classList.toggle("active", quizMode === "random");
      $modeSeqBtn.classList.toggle("active", quizMode === "sequential");
      const $adaptiveBtn = document.getElementById('modeAdaptiveBtn');
      if ($adaptiveBtn) $adaptiveBtn.classList.toggle("active", quizMode === "adaptive");
    }

    function changePracticeCount() {
      invalidateQuestionFlow();
      const $pc = document.getElementById("practiceCount");
      if ($pc) {
        practiceCount = $pc.value;
        if (!isDemoMode) localStorage.setItem("vocab_tester_count", practiceCount);
      }
      if (isDemoMode) {
        renderDemoScene();
        return;
      }
      epochNumber = 1;
      sequentialIndex = 0;
      initEpoch();
    }

    function initEpoch() {
      if (isDemoMode) {
        currentScore = demoScenario?.score ?? 100;
        epochPool = [];
        epochTotal = 10;
        updateScoreUI();
        $epochFill.style.width = '30%';
        $epochCount.textContent = '已完成 3 / 10';
        $epochLabel.textContent = '第 1 轮';
        return;
      }
      currentScore = 100;
      localStorage.setItem(SCORE_KEY, currentScore);
      updateScoreUI();

      let count = words.length;
      if (practiceCount !== "all") {
        let n = parseInt(practiceCount, 10);
        if (!isNaN(n) && n > 0 && n < words.length) {
          count = n;
        }
      }

      if (quizMode === "random") {
        epochPool = [...words].sort(() => 0.5 - Math.random()).slice(0, count);
      } else {
        epochPool = [];
        for (let i = 0; i < count; i++) {
          let idx = (sequentialIndex + i) % words.length;
          epochPool.push(words[idx]);
        }
      }

      epochTotal = epochPool.length;
      updateProgressBar();
    }

    function updateProgressBar() {
      const shown = epochTotal - epochPool.length;
      const pct = epochTotal > 0 ? (shown / epochTotal) * 100 : 0;
      $epochFill.style.width = pct + "%";
      $epochCount.textContent = `已完成 ${shown} / ${epochTotal}`;
      $epochLabel.textContent = `第 ${epochNumber} 轮`;
    }

        let wordListVisible = false; // 显示/隐藏词表

    function toggleWordList() {
      wordListVisible = !wordListVisible;
      $wordList.classList.toggle("hidden", !wordListVisible);
      $toggleListBtn.textContent = wordListVisible ? "🙈 隐藏词表" : "👁 显示词表";
    }

        function downloadFile(content, filename, mimeType) { // 文件下载
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    async function saveToTxt() {
      if (isDemoMode) {
        const txt = wordsDb.map(word => `${word.term}:${word.meaning || ''}`).join('\n') + '\n';
        downloadFile(txt, 'vocab.txt', 'text/plain;charset=utf-8');
      } else if (isElectron) {
        const json = await window.electronAPI.db.exportJson();
        const parsed = JSON.parse(json);
        const txt = parsed.map(w => `${w.term}:${w.meaning}`).join('\n') + '\n';
        downloadFile(txt, 'vocab.txt', 'text/plain;charset=utf-8');
      } else {
        downloadFile(words.join('\n') + '\n', 'vocab.txt', 'text/plain;charset=utf-8');
      }
    }

    async function exportWords() {
      if (isDemoMode) {
        downloadFile(JSON.stringify(wordsDb, null, 2), 'vocab_list.json', 'application/json');
      } else if (isElectron) {
        const json = await window.electronAPI.db.exportJson();
        downloadFile(json, 'vocab_list.json', 'application/json');
      } else {
        downloadFile(JSON.stringify(words, null, 2), 'vocab_list.json', 'application/json');
      }
    }

        async function importFile(event) { // 导入词表
      const file = event.target.files[0];
      if (!file) return;

      if (isElectron && !isDemoMode) {
        
        event.target.value = '';
        const result = await window.electronAPI.db.importDialog();
        if (result && !result.canceled) {
          if (result.error) {
            showResult('error-msg', '⚠️ 导入失败', result.error);
          } else {
            wordsDb = await window.electronAPI.db.getAllWords();
            words = wordsDb.map(w => w.term);
            syncWordSet();
            renderWordList();
            epochNumber = 1; sequentialIndex = 0; initEpoch();
            showResult('correct', '✅ 导入成功',
              `导入 ${result.imported} 个新单词（跳过 ${result.skipped} 个重复）`);
            if (!wordListVisible) toggleWordList();
          }
        }
        return;
      }

            const isTxt = file.name.toLowerCase().endsWith('.txt'); // 浏览器下用 JS 解析
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          let newWords = [];
          if (isTxt) {
            newWords = e.target.result
              .split(/\r?\n/)
              .map(w => w.trim().toLowerCase())
              .filter(w => w.length > 0 && /^[a-z\-' ]+$/i.test(w));
          } else {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error('格式错误');
            newWords = imported
              .filter(w => typeof w === 'string')
              .map(w => w.trim().toLowerCase())
              .filter(w => w.length > 0);
          }
          let addedCount = 0;
          for (const w of newWords) {
            if (!wordSet.has(w)) { words.push(w); wordSet.add(w); addedCount++; }
          }
          renderWordList();
          epochNumber = 1; sequentialIndex = 0; initEpoch();
          const skipped = newWords.length - addedCount;
          showResult('correct', '✅ 导入成功',
            `从 ${isTxt ? 'TXT' : 'JSON'} 文件导入了 ${addedCount} 个新单词` +
            (skipped > 0 ? `（跳过 ${skipped} 个重复项）` : ''));
          if (!wordListVisible) toggleWordList();
        } catch {
          showResult('error-msg', '⚠️ 导入失败', '文件格式不正确。');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    
    const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(text) {
      return String(text ?? '').replace(/[&<>"']/g, c => _escapeMap[c]);
    }

        function updateScoreUI() { // Score & Hints System
      const scoreSpan = document.getElementById("currentScoreSpan");
      if (scoreSpan) scoreSpan.textContent = currentScore;
    }

    function showToast(msg, type = 'info') {
      let container = document.getElementById('toastContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.textContent = msg;
      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('fadeOut');
        toast.addEventListener('animationend', () => toast.remove());
      }, 3000);
    }

    function deductPoints(pts) {
      if (pts <= 0) return;
      currentScore -= pts;
      if (!isDemoMode) localStorage.setItem(SCORE_KEY, currentScore);
      updateScoreUI();
      showToast(`💡 提示扣除 ${pts} 积分！`, 'error');
    }

    async function requestHint(level) {
      if (licenseState && licenseState.status === 'expired') { showLicenseLock(); return; }
      if (!currentWord) return;
      if (compactModelProfiles.has(currentModelProfile) && level > 1) {
        const profileName = currentModelProfile === 'wordwise' ? 'QWEN-WordWise' : 'QWEN 低算力模式';
        showToast(`${profileName} 仅支持本地 L1 提示，请切换至 QWEN-Pro。`, 'info');
        return;
      }

      let cost = 0;
      if (level === 2) cost = 10;
      if (level === 3) cost = 30;

      if (currentScore - cost < 0) {
        showToast(`积分不足！需要 ${cost} 积分，当前仅有 ${currentScore} 积分。`, 'error');
        return;
      }

      if (isDemoMode) {
        requestDemoHint(level, cost);
        return;
      }

      const btn = document.getElementById(`hintLevel${level}Btn`);
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "⏳ Generating...";

      try {
        if (!isElectron) throw new Error("请在 Electron 端运行以使用 AI 提示。");

        const result = await window.electronAPI.getHint(currentWord, level);
        if (result?.status === 'cancelled') return;
        if (result?.status !== 'ok' || !result.hint) {
          throw new Error(result?.error || '提示结果无法验证。');
        }
        const hintText = result.hint;

        showHintResult(level, hintText);

        if (level === 1) {
          document.getElementById('hintLevel2Container').style.display = compactModelProfiles.has(currentModelProfile) ? 'none' : 'block';
          btn.style.display = 'none';
        } else if (level === 2) {
          deductPoints(10);
          document.getElementById('hintLevel3Container').style.display = 'block';
          btn.style.display = 'none';
        } else if (level === 3) {
          deductPoints(30);
          btn.style.display = 'none';
        }
      } catch (err) {
        let message = err.message;
        if (message.includes('Model not loaded')) {
          message = "模型未加载，请选择模型。";
        }
        showToast(`提示获取失败: ${message}`, 'error');
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    function requestDemoHint(level, cost) {
      const hintText = demoScenario?.hints?.[level - 1];
      if (!hintText) {
        showToast('当前提示内容不可用。', 'error');
        return;
      }
      const button = document.getElementById(`hintLevel${level}Btn`);
      showHintResult(level, hintText);
      if (button) button.style.display = 'none';
      if (cost > 0) deductPoints(cost);
      const nextContainer = document.getElementById(`hintLevel${level + 1}Container`);
      if (nextContainer && level < 3) nextContainer.style.display = 'block';
      demoScenario.hintDepth = Math.max(demoScenario.hintDepth, level);
    }

    function showHintResult(level, text) {
      let container = document.getElementById('hintResultContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'hintResultContainer';
        const hintSec = document.querySelector('.hints-stack');
        hintSec.parentNode.insertBefore(container, hintSec);
      }
      const box = document.createElement('div');
      box.className = 'hint-box';
      box.innerHTML = `<span class="hint-box-level-label">Level ${level} Hint</span><span>${escapeHtml(text)}</span>`;
      container.appendChild(box);
    }

    function resetHints() {
      if (isElectron && !isDemoMode) window.electronAPI.cancelHint().catch(() => {});
      const container = document.getElementById('hintResultContainer');
      if (container) container.remove();

      const hintSec = document.querySelector('.hints-stack');
      if (hintSec) hintSec.style.display = 'flex';

      const hints = [document.getElementById('hintLevel1Btn'), document.getElementById('hintLevel2Btn'), document.getElementById('hintLevel3Btn')];
      hints.forEach((btn, idx) => {
        if (btn) {
          btn.disabled = false;
          btn.style.display = 'block';
          if (idx === 0) {
            btn.textContent = compactModelProfiles.has(currentModelProfile) ? "💡 L1 本地提示 (免费)" : "💡 L1 提示 (免费)";
            document.getElementById('hintLevel1Container').style.display = 'block';
          } else if (idx === 1) {
            btn.textContent = "💡 L2 提示 (-10 积分)";
            document.getElementById(`hintLevel${idx + 1}Container`).style.display = 'none';
          } else if (idx === 2) {
            btn.textContent = "💡 L3 提示 (-30 积分)";
            document.getElementById(`hintLevel${idx + 1}Container`).style.display = 'none';
          }
        }
      });
      if (compactModelProfiles.has(currentModelProfile)) {
        document.getElementById('hintLevel2Container').style.display = 'none';
        document.getElementById('hintLevel3Container').style.display = 'none';
      }
    }

    function disableHintsOnCorrect() {
      [1, 2, 3].forEach(level => {
        const btn = document.getElementById(`hintLevel${level}Btn`);
        if (btn) btn.disabled = true;
      });
    }

    

    function showScoreRing(score) { // SVG 环形动画：stroke-dashoffset 从满到零，按分数着色并计数
      const container = document.getElementById('scoreRingContainer');
      const fill = document.getElementById('scoreRingFill');
      const valueEl = document.getElementById('scoreRingValue');
      const labelEl = document.getElementById('scoreRingLabel');
      if (!container || !fill || !valueEl) return;

      container.classList.add('show');

            const circumference = 251.2; // 周长计算
      const offset = circumference - (score / 100) * circumference;

      
      let color, label, commentClass;
      if (score >= 90) {
        color = '#10b981'; label = '🎉 出色！'; commentClass = 'excellent';
      } else if (score >= 75) {
        color = '#3b82f6'; label = '👍 不错！'; commentClass = 'good';
      } else if (score >= 60) {
        color = '#f59e0b'; label = '💪 加油！'; commentClass = 'fair';
      } else {
        color = '#f43f5e'; label = '📖 继续努力'; commentClass = 'poor';
      }

      fill.style.stroke = color;
      
      requestAnimationFrame(() => {
        fill.style.strokeDashoffset = offset;
      });

      
      animateScoreValue(valueEl, 0, score, 800);

      if (labelEl) {
        labelEl.innerHTML = `<span class="score-comment ${commentClass}">${label}</span>`;
      }
    }

    function hideScoreRing() {
      const container = document.getElementById('scoreRingContainer');
      const fill = document.getElementById('scoreRingFill');
      if (container) container.classList.remove('show');
      if (fill) fill.style.strokeDashoffset = 251.2;
    }

    function animateScoreValue(el, from, to, duration) {
      const start = performance.now();
      function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3); // 三次缓出
        const current = Math.round(from + (to - from) * eased);
        el.innerHTML = `${current}<small>分</small>`;
        if (progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    function updateDifficultyUI(level) { // 难度1-10映射为10颗星星，同步联动顶部AI等级显示
      const starsEl = document.getElementById('diffStars');
      if (!starsEl) return;
      const clamped = Math.max(1, Math.min(10, level));
      let html = '';
      for (let i = 1; i <= 10; i++) {
        html += `<span class="${i <= clamped ? 'diff-star-on' : 'diff-star-off'}">★</span>`;
      }
      starsEl.innerHTML = html;

            const aiStars = document.querySelector('.ai-stars'); // 同步顶部 AI 等级星标
      if (aiStars) {
        const aiLevel = Math.ceil(clamped / 2); // Map 1-10 to 1-5
        let aiHtml = '';
        for (let i = 1; i <= 5; i++) {
          aiHtml += `<span class="${i <= aiLevel ? 'star-filled' : 'star-empty'}">★</span>`;
        }
        aiStars.innerHTML = aiHtml;
      }
    }

    function updateMasteryMeter(mastery) { // 将后端返回的掌握度(0-100)可视化为渐变色进度条，与 SM-2 模型联动
      const meter = document.getElementById('masteryMeter');
      const fill = document.getElementById('masteryFill');
      const valueEl = document.getElementById('masteryValue');
      if (!meter || !fill || !valueEl) return;

      meter.classList.add('show');
      const pct = Math.max(0, Math.min(100, Math.round(mastery)));
      fill.style.width = pct + '%';
      valueEl.textContent = pct + '%';

      
      if (pct >= 80) {
        fill.style.background = 'linear-gradient(90deg, #10b981, #34d399)';
      } else if (pct >= 60) {
        fill.style.background = 'linear-gradient(90deg, #3b82f6, #60a5fa)';
      } else if (pct >= 40) {
        fill.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
      } else {
        fill.style.background = 'linear-gradient(90deg, #f43f5e, #fb7185)';
      }
    }

    function showStubbornBadge() {
      let badge = document.getElementById('stubbornBadge');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'stubbornBadge';
        badge.className = 'stubborn-badge';
        badge.title = '顽固词：这个词你反复遗忘，需要重点练习';
        badge.textContent = '🔥 顽固词';
        const wordArea = document.querySelector('.word-display') || $currentWord?.parentElement;
        if (wordArea) wordArea.appendChild(badge);
      }
      badge.style.display = 'inline-block';
    }

    function hideStubbornBadge() {
      const badge = document.getElementById('stubbornBadge');
      if (badge) badge.style.display = 'none';
    }

    function showConfusionAlert(hint) {
      let container = document.getElementById('confusionAlertBox');
      if (!container) {
        container = document.createElement('div');
        container.id = 'confusionAlertBox';
        container.className = 'confusion-alert';
        if ($resultBox && $resultBox.parentNode) {
          $resultBox.parentNode.insertBefore(container, $resultBox.nextSibling);
        } else {
          document.body.appendChild(container);
        }
      }
      container.innerHTML = `<div class="confusion-alert-inner">
        <span class="confusion-icon">🔀</span>
        <span class="confusion-text">${escapeHtml(hint)}</span>
      </div>`;
      container.style.display = 'block';

      if (!isDemoMode) {
        setTimeout(() => {
          if (container) container.style.display = 'none';
        }, 10000);
      }
    }

    // ===== 会员授权 UI =====
    let licenseState = null;

    async function initLicenseUI() {
      try {
        const code = await window.electronAPI.license.getDeviceCode();
        const codeEls = document.querySelectorAll('#licenseDeviceCode, #licenseLockDeviceCode');
        codeEls.forEach(el => { if (el) el.textContent = code || '—'; });
      } catch (e) { console.warn('[License] 设备码读取失败', e); }

      try {
        licenseState = await window.electronAPI.license.getState();
        renderLicenseState(licenseState);
      } catch (e) { console.warn('[License] 状态读取失败', e); }

      window.electronAPI.license.onStateChange((state) => {
        licenseState = state;
        renderLicenseState(state);
      });
    }

    function showLicenseLock() {
      const overlay = document.getElementById('licenseExpiredOverlay');
      if (overlay) {
        overlay.style.display = 'flex';
        overlay.classList.add('active');
      }
    }

    function renderLicenseState(state) {
      if (!state) return;
      licenseState = state;
      const badge = document.getElementById('licenseBadge');
      if (badge) {
        badge.classList.remove('is-trial', 'is-active', 'is-expired');
        if (state.status === 'active') {
          badge.classList.add('is-active');
          badge.textContent = state.betaSuper ? '内测超级许可'
            : (state.tier === 'life' ? '终身会员'
              : (state.tier === 'y1' ? '一年会员' : state.tier === 'y2' ? '两年会员' : '半年会员'));
        } else if (state.status === 'trial') {
          badge.classList.add('is-trial');
          badge.textContent = `试用 ${state.daysLeft} 天`;
        } else {
          badge.classList.add('is-expired');
          badge.textContent = '已到期';
        }
      }

      const statusLine = document.getElementById('licenseStatusLine');
      if (statusLine) {
        if (state.status === 'active') {
          const exp = state.expiresAt
            ? new Date(state.expiresAt * 1000).toLocaleDateString('zh-CN')
            : '永不过期';
          const tierLabel = state.betaSuper ? '内测超级许可'
            : (state.tier === 'life' ? '终身会员' : '会员');
          statusLine.textContent = `✅ 已开通${tierLabel}，到期：${exp}`;
        } else if (state.status === 'trial') {
          statusLine.textContent = `🕒 试用中，剩余 ${state.daysLeft} 天`;
        } else {
          statusLine.textContent = '🔒 会员已到期，请开通后继续使用';
        }
      }

      const overlay = document.getElementById('licenseExpiredOverlay');
      if (overlay) {
        const expired = state.status === 'expired';
        overlay.style.display = expired ? 'flex' : 'none';
        overlay.classList.toggle('active', expired);
      }

      // 到期时强制关闭设置弹窗，避免在锁屏下操作
      if (state.status === 'expired') {
        const settings = document.getElementById('settingsModalOverlay');
        if (settings) {
          settings.style.display = 'none';
          settings.classList.remove('active');
        }
      } else {
        const settings = document.getElementById('settingsModalOverlay');
        if (settings) settings.style.display = '';
      }
    }

    async function copyLicenseDeviceCode() {
      const code = document.getElementById('licenseDeviceCode')?.textContent
        || document.getElementById('licenseLockDeviceCode')?.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        showToast('设备码已复制', 'success');
      } catch (e) {
        showToast('复制失败，请手动选择', 'warning');
      }
    }

    async function activateLicense(fromLock) {
      const input = fromLock
        ? document.getElementById('licenseLockCodeInput')
        : document.getElementById('licenseCodeInput');
      const statusEl = fromLock
        ? document.getElementById('licenseLockActivateStatus')
        : document.getElementById('licenseActivateStatus');
      const code = (input?.value || '').trim();
      if (!code) {
        if (statusEl) { statusEl.textContent = '请输入激活码'; statusEl.className = 'license-activate-status err'; }
        return;
      }
      if (statusEl) { statusEl.textContent = '正在激活…'; statusEl.className = 'license-activate-status'; }
      try {
        const res = await window.electronAPI.license.activate(code);
        if (res && res.ok) {
          if (statusEl) { statusEl.textContent = '✅ 激活成功'; statusEl.className = 'license-activate-status ok'; }
          if (input) input.value = '';
          licenseState = res.state;
          renderLicenseState(res.state);
          showToast('会员激活成功', 'success');
        } else {
          const reasonMap = {
            device: '激活码与本机设备不匹配',
            expired: '激活码已过期',
            invalid: '激活码无效',
            beta_used: '内测超级码已经使用过，只能绑定一台本机',
            already_active: '当前设备已经有有效会员，无需使用内测超级码',
          };
          const msg = reasonMap[res?.reason] || '激活失败';
          if (statusEl) { statusEl.textContent = '❌ ' + msg; statusEl.className = 'license-activate-status err'; }
        }
      } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ 激活异常：' + e.message; statusEl.className = 'license-activate-status err'; }
      }
    }

    init();
