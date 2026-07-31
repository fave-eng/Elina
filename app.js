(() => {
  'use strict';

  const config = window.APP_CONFIG || {};
  const student = config.student || {};
  let HOMEWORK_DATA = [];
  const RAW_VOCABULARY_DATA = Array.isArray(window.VOCABULARY_DATA) ? window.VOCABULARY_DATA : [];
  const GRAMMAR_DATA = Array.isArray(window.GRAMMAR_DATA) ? window.GRAMMAR_DATA : [];
  const lessonCache = new Map();
  const lessonsPath = 'data/lessons';
  const maxLessonNumber = 200;
  const maxConsecutiveMissingLessons = 3;

  const safeText = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
  const escapeHtml = (value) => safeText(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const byId = (id) => document.getElementById(id);
  const queryParam = (name) => new URLSearchParams(window.location.search).get(name) || '';
  const unique = (items) => [...new Set(Array.isArray(items) ? items : [])];
  const safePercent = (value, total) => {
    const numerator = Number(value) || 0;
    const denominator = Number(total) || 0;
    if (denominator <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
  };
  const shuffled = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const dateMs = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  };

  function normalizeLesson(rawLesson, requestedId = '') {
    if (!rawLesson || typeof rawLesson !== 'object') return null;
    const id = safeText(rawLesson.id || requestedId).trim();
    if (!/^lesson-\d+$/.test(id)) return null;
    const inferredNumber = Number(id.replace('lesson-', '')) || 0;
    return {
      ...rawLesson,
      id,
      // The homework number is always derived from the lesson-N.json file name.
      // This keeps homework numbering sequential when vocabulary or grammar materials are added.
      number: inferredNumber,
      title: safeText(rawLesson.title, `Lesson ${inferredNumber}`),
      subtitle: safeText(rawLesson.subtitle, 'Interactive homework assignment'),
      status: safeText(rawLesson.status, 'available'),
      page: safeText(rawLesson.page).trim() || `lesson.html?id=${encodeURIComponent(id)}`,
      blocks: Array.isArray(rawLesson.blocks) ? rawLesson.blocks : []
    };
  }

  async function fetchLessonFile(id) {
    const cleanId = safeText(id).trim();
    if (!/^lesson-\d+$/.test(cleanId)) return null;
    if (lessonCache.has(cleanId)) return lessonCache.get(cleanId);

    const promise = (async () => {
      const url = new URL(`${lessonsPath}/${cleanId}.json`, document.baseURI);
      const response = await fetch(url, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Could not load ${cleanId}.json: ${response.status}`);
      const lesson = normalizeLesson(await response.json(), cleanId);
      if (!lesson) throw new Error(`File ${cleanId}.json has an invalid structure.`);
      return lesson;
    })();

    lessonCache.set(cleanId, promise);
    try {
      return await promise;
    } catch (error) {
      lessonCache.delete(cleanId);
      throw error;
    }
  }

  async function discoverHomeworkData() {
    const lessons = [];
    let consecutiveMissing = 0;

    for (let number = 1; number <= maxLessonNumber; number += 1) {
      const lesson = await fetchLessonFile(`lesson-${number}`);
      if (lesson) {
        lessons.push(lesson);
        consecutiveMissing = 0;
      } else {
        consecutiveMissing += 1;
        if (consecutiveMissing >= maxConsecutiveMissingLessons) break;
      }
    }

    return lessons.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
  }

  async function loadHomeworkData() {
    const view = document.body?.dataset?.view || '';
    const requestedId = queryParam('id');

    if (view === 'lesson' && requestedId) {
      const lesson = await fetchLessonFile(requestedId);
      HOMEWORK_DATA = lesson ? [lesson] : [];
    } else {
      HOMEWORK_DATA = await discoverHomeworkData();
    }

    window.HOMEWORK_DATA = HOMEWORK_DATA;
    return HOMEWORK_DATA;
  }

  async function resolveLessonContent(lesson) {
    return lesson || null;
  }

  function normalizeWordKey(value) {
    return safeText(value)
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[’‘`]/g, "'")
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^[\s.,!?;:()[\]{}"“”]+|[\s.,!?;:()[\]{}"“”]+$/g, '');
  }

  function buildVocabularyCatalog(topics) {
    const seen = new Map();
    const byKey = new Map();
    const idToKey = new Map();
    const duplicates = [];
    const preparedTopics = topics.map((topic) => {
      const words = [];
      (Array.isArray(topic.words) ? topic.words : []).forEach((sourceWord) => {
        const wordKey = normalizeWordKey(sourceWord.uniqueKey || sourceWord.en);
        if (!wordKey) return;
        idToKey.set(safeText(sourceWord.id), wordKey);
        if (seen.has(wordKey)) {
          duplicates.push({ wordKey, skippedTopicId: topic.id, firstTopicId: seen.get(wordKey).topicId });
          return;
        }
        const word = { ...sourceWord, __wordKey: wordKey };
        const record = { word, topicId: topic.id };
        seen.set(wordKey, record);
        byKey.set(wordKey, record);
        words.push(word);
      });
      return { ...topic, words };
    });
    if (duplicates.length) {
      console.info('Duplicate words were excluded from the vocabulary:', duplicates);
    }
    return {
      topics: preparedTopics.filter((topic) => topic.words.length > 0),
      allTopics: preparedTopics,
      allWords: [...byKey.values()].map((item) => item.word),
      byKey,
      idToKey,
      duplicates
    };
  }

  const VOCABULARY_CATALOG = buildVocabularyCatalog(RAW_VOCABULARY_DATA);
  const VOCABULARY_DATA = VOCABULARY_CATALOG.topics;


  function migrateLegacyLocalProgress() {
    try {
      const homeworkKey = key('homework');
      const homework = storage.read(homeworkKey, {});
      homework.completedIds = unique(homework.completedIds);
      homework.results = homework.results && typeof homework.results === 'object' ? homework.results : {};
      homework.submissions = homework.submissions && typeof homework.submissions === 'object' ? homework.submissions : {};
      let homeworkChanged = false;
      [1, 2, 3].forEach((number) => {
        const score = window.localStorage.getItem(`elina_hw${number}_score`);
        if (!score || homework.results[`lesson-${number}`]) return;
        const match = score.match(/(\d+)\s*\/\s*(\d+)/);
        if (!match) return;
        const correct = Number(match[1]);
        const total = Number(match[2]);
        let answers = {};
        try { answers = JSON.parse(window.localStorage.getItem(`elina_hw${number}_answers`) || '{}') || {}; } catch (_) {}
        homework.results[`lesson-${number}`] = {
          correct, total, percent: safePercent(correct, total), answers,
          checkedAt: new Date().toISOString()
        };
        homework.submissions[`lesson-${number}`] = { savedAt: new Date().toISOString(), status: 'legacy' };
        homework.completedIds.push(`lesson-${number}`);
        homeworkChanged = true;
      });
      if (homeworkChanged) {
        homework.completedIds = unique(homework.completedIds);
        homework._updatedAt = new Date().toISOString();
        storage.write(homeworkKey, homework);
      }

      const vocabularyKey = key('vocabulary');
      const vocabulary = normalizeVocabularyProgress(storage.read(vocabularyKey, {}));
      let vocabularyChanged = false;
      const importArray = (localKey, topicId) => {
        let values = [];
        try { values = JSON.parse(window.localStorage.getItem(localKey) || '[]') || []; } catch (_) {}
        const known = new Set(values.map((item) => normalizeWordKey(item)));
        const topic = VOCABULARY_CATALOG.allTopics.find((item) => item.id === topicId);
        (topic?.words || []).forEach((word) => {
          if (!known.has(word.__wordKey) || vocabulary.words[word.__wordKey]) return;
          vocabulary.words[word.__wordKey] = { status: 'known', topicId, learnedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          vocabularyChanged = true;
        });
      };
      importArray('elina_vocab_l1_known', 'vocab-lesson-1');
      importArray('elina_vocab_l2_known', 'vocab-lesson-2');
      importArray('elina_vocab_verbs_known', 'vocab-irregular-verbs');
      let legacyStatuses = {};
      try { legacyStatuses = JSON.parse(window.localStorage.getItem('elina_vocab_l3_status') || '{}') || {}; } catch (_) {}
      const l3 = VOCABULARY_CATALOG.allTopics.find((item) => item.id === 'vocab-lesson-3');
      (l3?.words || []).forEach((word) => {
        if (vocabulary.words[word.__wordKey]) return;
        const legacy = legacyStatuses[word.en];
        if (!legacy) return;
        vocabulary.words[word.__wordKey] = {
          status: legacy === 'known' ? 'known' : legacy === 'reviewed' ? 'reviewed' : 'difficult',
          topicId: 'vocab-lesson-3',
          learnedAt: legacy === 'known' ? new Date().toISOString() : null,
          updatedAt: new Date().toISOString()
        };
        vocabularyChanged = true;
      });
      if (vocabularyChanged) {
        vocabulary._updatedAt = new Date().toISOString();
        storage.write(vocabularyKey, vocabulary);
      }
    } catch (error) {
      console.warn('Legacy progress migration failed:', error);
    }
  }

  function showToast(message) {
    const toast = byId('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  const storage = {
    read(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        console.warn('Could not read local progress:', error);
        return fallback;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn('Could not save local progress:', error);
        return false;
      }
    }
  };

  const studentId = safeText(student.id, 'student').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
  const key = (section) => `english_space_${studentId}_${section}`;
  const cloudMode = 'tables';
  const singleRow = config.supabase?.singleRow || {};
  const tables = {
    homework: config.supabase?.tables?.homework || 'homework_progress',
    vocabulary: config.supabase?.tables?.vocabulary || 'vocabulary_progress',
    vocabularyTopics: config.supabase?.tables?.vocabularyTopics || 'vocabulary_topic_progress',
    grammar: config.supabase?.tables?.grammar || 'grammar_progress'
  };

  const CloudService = {
    client: null,
    syncing: false,
    timers: {},
    isConfigured() {
      return Boolean(
        config.features?.cloudSync &&
        safeText(config.supabase?.url).trim() &&
        safeText(config.supabase?.anonKey).trim() &&
        window.supabase?.createClient
      );
    },
    async init() {
      if (!this.isConfigured()) return null;
      if (!this.client) {
        // Remove the stored session from the previous site version.
        // Otherwise Supabase may send requests as authenticated,
        // although the current setup expects the anon role.
        try {
          const projectRef = new URL(config.supabase.url).hostname.split('.')[0];
          window.localStorage.removeItem(`sb-${projectRef}-auth-token`);
        } catch (error) {
          console.warn('Could not clear the old Supabase session:', error);
        }

        const emptyAuthStorage = {
          getItem() { return null; },
          setItem() {},
          removeItem() {}
        };

        this.client = window.supabase.createClient(
          config.supabase.url,
          config.supabase.anonKey,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false,
              storage: emptyAuthStorage
            }
          }
        );
      }
      return this.client;
    },
    queue(section) {
      if (!this.isConfigured() || !this.client || this.syncing) return;
      window.clearTimeout(this.timers[section]);
      this.timers[section] = window.setTimeout(() => {
        window.ProgressService.syncToCloud(section).catch((error) => {
          console.error('Cloud save error:', error);
          showToast('Could not save progress to Supabase');
        });
      }, 450);
    }
  };


  const HomeworkReportService = {
    isConfigured() {
      return Boolean(
        config.features?.telegramNotifications &&
        CloudService.isConfigured()
      );
    },
    async send(lessonId) {
      if (!this.isConfigured()) {
        return { ok: false, skipped: true, reason: 'not_configured' };
      }

      const baseUrl = safeText(config.supabase?.url).replace(/\/+$/, '');
      const anonKey = safeText(config.supabase?.anonKey).trim();
      const endpoint = `${baseUrl}/functions/v1/notify-telegram`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`
        },
        body: JSON.stringify({
          eventType: 'homework_report',
          studentId,
          lessonId,
          lessonUrl: window.location.href
        })
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || `Homework report error: HTTP ${response.status}`);
      }
      return result;
    }
  };

  function normalizeVocabularyProgress(value) {
    const words = value?.words && typeof value.words === 'object' ? { ...value.words } : {};
    const topics = {};
    Object.entries(value?.topics && typeof value.topics === 'object' ? value.topics : {}).forEach(([topicId, topic]) => {
      topics[topicId] = { tests: Array.isArray(topic?.tests) ? topic.tests : [] };
      unique(topic?.known).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey) words[wordKey] = { status: 'known', topicId, learnedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      });
      unique(topic?.difficult).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey && words[wordKey]?.status !== 'known') words[wordKey] = { status: 'difficult', topicId, updatedAt: new Date().toISOString() };
      });
    });
    Object.entries(words).forEach(([wordKey, item]) => {
      if (!['known', 'reviewed', 'difficult'].includes(item?.status)) delete words[wordKey];
    });
    return { words, topics, _updatedAt: safeText(value?._updatedAt) };
  }

  window.ProgressService = {
    loadHomeworkProgress() {
      const value = storage.read(key('homework'), {});
      return {
        completedIds: unique(value.completedIds),
        results: value.results && typeof value.results === 'object' ? value.results : {},
        submissions: value.submissions && typeof value.submissions === 'object' ? value.submissions : {},
        _updatedAt: safeText(value._updatedAt)
      };
    },
    saveHomeworkProgress(progress) {
      const value = { ...(progress || {}), _updatedAt: new Date().toISOString() };
      const ok = storage.write(key('homework'), value);
      CloudService.queue('homework');
      return ok;
    },
    loadVocabularyProgress() {
      return normalizeVocabularyProgress(storage.read(key('vocabulary'), {}));
    },
    saveVocabularyProgress(progress) {
      const normalized = normalizeVocabularyProgress({ ...(progress || {}), _updatedAt: new Date().toISOString() });
      const ok = storage.write(key('vocabulary'), normalized);
      const difficult = Object.entries(normalized.words)
        .filter(([, item]) => item.status === 'difficult')
        .map(([wordKey]) => wordKey);
      storage.write(key('difficult_words'), difficult);
      CloudService.queue('vocabulary');
      return ok;
    },
    loadGrammarProgress() {
      const value = storage.read(key('grammar'), {});
      return { topics: value.topics && typeof value.topics === 'object' ? value.topics : {}, _updatedAt: safeText(value._updatedAt) };
    },
    saveGrammarProgress(progress) {
      const value = { ...(progress || {}), _updatedAt: new Date().toISOString() };
      const ok = storage.write(key('grammar'), value);
      CloudService.queue('grammar');
      return ok;
    },

    async syncFromSingleRow() {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      const client = CloudService.client;
      const table = safeText(singleRow.table, 'progress');
      const studentColumn = safeText(singleRow.studentColumn, 'student');
      const payloadColumn = safeText(singleRow.payloadColumn, 'vocab_progress');
      const stateKey = safeText(singleRow.stateKey, '__englishSpace');
      const response = await client.from(table).select(`${payloadColumn},updated_at`).eq(studentColumn, studentId).maybeSingle();
      if (response.error) throw response.error;
      const payload = response.data?.[payloadColumn];
      const remoteState = payload && typeof payload === 'object' ? payload[stateKey] : null;
      if (remoteState && typeof remoteState === 'object') {
        const pairs = [
          ['homework', this.loadHomeworkProgress()],
          ['vocabulary', this.loadVocabularyProgress()],
          ['grammar', this.loadGrammarProgress()]
        ];
        pairs.forEach(([section, local]) => {
          const remote = remoteState[section];
          if (remote && dateMs(remote._updatedAt || remoteState.updatedAt) > dateMs(local._updatedAt)) {
            storage.write(key(section), remote);
          }
        });
      }
      await this.syncToSingleRow();
      return true;
    },
    async syncToSingleRow() {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      const client = CloudService.client;
      const table = safeText(singleRow.table, 'progress');
      const studentColumn = safeText(singleRow.studentColumn, 'student');
      const payloadColumn = safeText(singleRow.payloadColumn, 'vocab_progress');
      const stateKey = safeText(singleRow.stateKey, '__englishSpace');
      const current = await client.from(table).select(payloadColumn).eq(studentColumn, studentId).maybeSingle();
      if (current.error) throw current.error;
      const payload = current.data?.[payloadColumn] && typeof current.data[payloadColumn] === 'object'
        ? { ...current.data[payloadColumn] } : {};
      const previousState = payload[stateKey] && typeof payload[stateKey] === 'object' ? payload[stateKey] : {};
      const now = new Date().toISOString();
      payload[stateKey] = {
        homework: this.loadHomeworkProgress(),
        vocabulary: this.loadVocabularyProgress(),
        grammar: this.loadGrammarProgress(),
        drafts: previousState.drafts || {},
        updatedAt: now
      };
      const row = { [studentColumn]: studentId, [payloadColumn]: payload, updated_at: now };
      const response = await client.from(table).upsert(row, { onConflict: studentColumn });
      if (response.error) throw response.error;
      return true;
    },
    async syncFromCloud() {
      if (cloudMode === 'single-row') return this.syncFromSingleRow();
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      CloudService.syncing = true;
      try {
        const client = CloudService.client;
        const [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse] = await Promise.all([
          client.from(tables.homework).select('*').eq('student_id', studentId),
          client.from(tables.vocabulary).select('*').eq('student_id', studentId),
          client.from(tables.vocabularyTopics).select('*').eq('student_id', studentId),
          client.from(tables.grammar).select('*').eq('student_id', studentId)
        ]);
        [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse].forEach((response) => {
          if (response.error) throw response.error;
        });

        const homework = this.loadHomeworkProgress();
        (homeworkResponse.data || []).forEach((row) => {
          const localResult = homework.results[row.lesson_id];
          if (!localResult || dateMs(row.updated_at) >= dateMs(localResult.checkedAt)) {
            homework.results[row.lesson_id] = {
              correct: Number(row.score_correct || 0),
              total: Number(row.score_total || 0),
              percent: Number(row.score_percent || 0),
              answers: row.answers && typeof row.answers === 'object' ? row.answers : {},
              checkedAt: row.checked_at || row.updated_at
            };
          }
          if (row.status === 'submitted') {
            homework.submissions[row.lesson_id] = { savedAt: row.submitted_at || row.updated_at, status: 'cloud' };
            // A homework assignment is counted as complete after it is submitted,
            // even if some answers are incorrect.
            homework.completedIds.push(row.lesson_id);
          } else if (Number(row.score_total) > 0 && Number(row.score_correct) === Number(row.score_total)) {
            homework.completedIds.push(row.lesson_id);
          }
        });
        homework.completedIds = unique(homework.completedIds);
        storage.write(key('homework'), homework);

        const vocabulary = this.loadVocabularyProgress();
        (vocabularyResponse.data || []).forEach((row) => {
          const local = vocabulary.words[row.word_key];
          if (!local || dateMs(row.updated_at) >= dateMs(local.updatedAt)) {
            vocabulary.words[row.word_key] = {
              status: row.status,
              topicId: row.source_topic_id || '',
              learnedAt: row.learned_at || null,
              updatedAt: row.updated_at
            };
          }
        });
        (vocabularyTopicsResponse.data || []).forEach((row) => {
          const localTests = vocabulary.topics[row.topic_id]?.tests || [];
          const cloudTests = Array.isArray(row.tests) ? row.tests : [];
          const merged = new Map();
          [...localTests, ...cloudTests].forEach((test) => merged.set(test.completedAt || JSON.stringify(test), test));
          vocabulary.topics[row.topic_id] = { tests: [...merged.values()] };
        });
        storage.write(key('vocabulary'), normalizeVocabularyProgress(vocabulary));

        const grammar = this.loadGrammarProgress();
        (grammarResponse.data || []).forEach((row) => {
          const local = grammar.topics[row.topic_id] || {};
          grammar.topics[row.topic_id] = {
            passed: Boolean(local.passed || row.passed),
            attempts: Math.max(Number(local.attempts || 0), Number(row.attempts || 0)),
            bestScore: Math.max(Number(local.bestScore || 0), Number(row.best_score || 0)),
            updatedAt: dateMs(row.updated_at) >= dateMs(local.updatedAt) ? row.updated_at : local.updatedAt
          };
        });
        storage.write(key('grammar'), grammar);
        await this.syncToCloud();
        return true;
      } finally {
        CloudService.syncing = false;
      }
    },
    async syncToCloud(section = 'all') {
      if (!CloudService.isConfigured()) return false;
      if (cloudMode === 'single-row') return this.syncToSingleRow();
      if (!CloudService.client) await CloudService.init();
      const client = CloudService.client;
      const sections = section === 'all' ? ['homework', 'vocabulary', 'grammar'] : [section];

      if (sections.includes('homework')) {
        const progress = this.loadHomeworkProgress();
        const lessonIds = unique([...Object.keys(progress.results), ...Object.keys(progress.submissions)]);
        const rows = lessonIds.map((lessonId) => {
          const result = progress.results[lessonId] || {};
          const submission = progress.submissions[lessonId];
          const lesson = HOMEWORK_DATA.find((item) => item.id === lessonId) || {};
          const total = Number(result.total || 0);
          const correct = Number(result.correct || 0);
          return {
            student_id: studentId,
            student_name: safeText(student.nameEn || student.nameRu),
            lesson_id: lessonId,
            lesson_title: safeText(lesson.title, lessonId),
            status: submission ? 'submitted' : (total > 0 ? 'checked' : 'draft'),
            answers: result.answers && typeof result.answers === 'object' ? result.answers : {},
            score_correct: total > 0 ? correct : null,
            score_total: total > 0 ? total : null,
            score_percent: total > 0 ? safePercent(correct, total) : null,
            checked_at: result.checkedAt || null,
            submitted_at: submission?.savedAt || null
          };
        });
        if (rows.length) {
          const { error } = await client.from(tables.homework).upsert(rows, { onConflict: 'student_id,lesson_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('vocabulary')) {
        const progress = this.loadVocabularyProgress();
        const wordRows = Object.entries(progress.words).filter(([wordKey]) => VOCABULARY_CATALOG.byKey.has(wordKey)).map(([wordKey, state]) => {
          const record = VOCABULARY_CATALOG.byKey.get(wordKey);
          return {
            student_id: studentId,
            word_key: wordKey,
            word_id: safeText(record?.word?.id, wordKey),
            en: safeText(record?.word?.en, wordKey),
            ru: safeText(record?.word?.ru),
            source_topic_id: state.topicId || record?.topicId || null,
            status: state.status,
            learned_at: state.status === 'known' ? (state.learnedAt || new Date().toISOString()) : null
          };
        });
        if (wordRows.length) {
          const { error } = await client.from(tables.vocabulary).upsert(wordRows, { onConflict: 'student_id,word_key' });
          if (error) throw error;
        }
        const topicRows = Object.entries(progress.topics)
          .filter(([, topic]) => Array.isArray(topic.tests) && topic.tests.length)
          .map(([topicId, topic]) => ({ student_id: studentId, topic_id: topicId, tests: topic.tests }));
        if (topicRows.length) {
          const { error } = await client.from(tables.vocabularyTopics).upsert(topicRows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('grammar')) {
        const progress = this.loadGrammarProgress();
        const rows = Object.entries(progress.topics).map(([topicId, state]) => ({
          student_id: studentId,
          topic_id: topicId,
          passed: Boolean(state.passed),
          attempts: Number(state.attempts || 0),
          best_score: Number(state.bestScore || 0)
        }));
        if (rows.length) {
          const { error } = await client.from(tables.grammar).upsert(rows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }
      return true;
    }
  };

  function fillConfig() {
    const values = {
      nameRu: student.nameRu,
      nameEn: student.nameEn,
      level: student.level,
      textbook: student.textbook,
      textbookEdition: student.textbookEdition
    };
    document.querySelectorAll('[data-config]').forEach((node) => {
      node.textContent = safeText(values[node.dataset.config]);
    });
    if (student.nameEn) document.title = `${document.title} · ${student.nameEn}`;
  }

  function markNavigation() {
    const page = document.body.dataset.page;
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === page;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
    });
  }

  function progressMarkup(label, value, total, tone = '') {
    const percent = safePercent(value, total);
    return `<div class="progress-row">
      <div class="progress-row-head"><strong>${escapeHtml(label)}</strong><span>${Number(value) || 0} of ${Number(total) || 0}</span></div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <div class="progress-fill ${tone}" style="width:${percent}%"></div>
      </div>
    </div>`;
  }

  function totals() {
    const hwProgress = window.ProgressService.loadHomeworkProgress();
    const vocabProgress = window.ProgressService.loadVocabularyProgress();
    const grammarProgress = window.ProgressService.loadGrammarProgress();
    const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed', 'locked'].includes(item.status));
    const completedHomework = publishedHomework.filter((item) => hwProgress.completedIds.includes(item.id) || item.status === 'completed').length;
    const knownWordKeys = Object.entries(vocabProgress.words).filter(([wordKey, item]) => VOCABULARY_CATALOG.byKey.has(wordKey) && item.status === 'known').map(([wordKey]) => wordKey);
    const passedGrammar = GRAMMAR_DATA.filter((topic) => grammarProgress.topics[topic.id]?.passed === true || topic.passed === true).length;
    return {
      homeworkTotal: publishedHomework.length,
      homeworkCompleted: completedHomework,
      vocabularyTotal: VOCABULARY_CATALOG.allWords.length,
      vocabularyKnown: knownWordKeys.length,
      vocabularyTopics: VOCABULARY_DATA.length,
      grammarTotal: GRAMMAR_DATA.filter((topic) => topic.status !== 'draft').length,
      grammarPassed: passedGrammar
    };
  }

  function emptyState(icon, title, text) {
    return `<div class="card empty-state"><div class="empty-state-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
  }

  function renderHome() {
    const t = totals();
    if (byId('home-stat-completed')) byId('home-stat-completed').textContent = t.homeworkCompleted;
    if (byId('vocab-stat-known')) byId('vocab-stat-known').textContent = t.vocabularyKnown;
    if (byId('grammar-stat-passed')) byId('grammar-stat-passed').textContent = t.grammarPassed;
    const list = byId('home-progress-list');
    if (list) list.innerHTML = [
      progressMarkup('Homework', t.homeworkCompleted, t.homeworkTotal),
      progressMarkup('Vocabulary', t.vocabularyKnown, t.vocabularyTotal, 'rose'),
      progressMarkup('Grammar', t.grammarPassed, t.grammarTotal, 'green')
    ].join('');
    const current = byId('current-material');
    if (current) {
      const homeworkProgress = window.ProgressService.loadHomeworkProgress();
      const currentHomework = HOMEWORK_DATA
        .filter((item) => item.status === 'available' && !homeworkProgress.completedIds.includes(item.id))
        .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt) || Number(b.number || 0) - Number(a.number || 0))[0];

      if (currentHomework) {
        const href = currentHomework.page || `lesson.html?id=${encodeURIComponent(currentHomework.id)}`;
        current.innerHTML = `<a class="card interactive item-card current-material-card" href="${escapeHtml(href)}">
          <div class="item-icon">✨</div>
          <div class="item-main"><span class="homework-number">Homework #${Number(currentHomework.number || 0)}</span><h3>${escapeHtml(safeText(currentHomework.title, 'Current assignment'))}</h3><p>${escapeHtml(safeText(currentHomework.subtitle, 'Continue working with the published material.'))}</p></div>
          <span class="status-badge status-available">Continue</span>
        </a>`;
      } else {
        const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed'].includes(item.status));
        const everythingCompleted = publishedHomework.length > 0 && publishedHomework.every((item) => item.status === 'completed' || homeworkProgress.completedIds.includes(item.id));
        current.innerHTML = everythingCompleted
          ? '<a class="card interactive item-card current-material-card" href="homework.html"><div class="item-icon">✅</div><div class="item-main"><h3>All published materials are complete</h3><p>New material will appear after the teacher publishes it.</p></div><span class="arrow" aria-hidden="true">→</span></a>'
          : '<div class="card disabled empty-state"><div class="empty-state-icon">✨</div><h3>No current material has been published yet</h3><p>The latest available homework assignment will appear here automatically.</p></div>';
      }
    }
  }


  function getLessonVocabularyTopic(lesson) {
    const vocabularyId = safeText(lesson?.vocabularyId).trim();
    return VOCABULARY_CATALOG.allTopics.find((topic) => topic.id === vocabularyId)
      || VOCABULARY_CATALOG.allTopics.find((topic) => topic.linkedLessonId === lesson?.id)
      || null;
  }

  function getLessonGrammarTopics(lesson) {
    const ids = Array.isArray(lesson?.grammarIds) ? lesson.grammarIds.map((id) => safeText(id).trim()).filter(Boolean) : [];
    const topics = ids.map((id) => GRAMMAR_DATA.find((topic) => topic.id === id)).filter(Boolean);
    GRAMMAR_DATA.filter((topic) => topic.linkedLessonId === lesson?.id).forEach((topic) => topics.push(topic));
    return [...new Map(topics.map((topic) => [topic.id, topic])).values()];
  }

  function compactGrammarTitle(topic) {
    const id = safeText(topic?.id).toLowerCase();
    if (id.includes('suffix')) return 'Suffixes';
    if (id.includes('pronoun')) return 'Pronouns';
    const title = safeText(topic?.title, 'Grammar').split(':')[0].trim();
    return title.length > 22 ? `${title.slice(0, 20).trim()}…` : title;
  }

  function lessonMaterialLinks(lesson, mode = 'hub') {
    const vocabulary = getLessonVocabularyTopic(lesson);
    const grammarTopics = getLessonGrammarTopics(lesson);
    if (!vocabulary && !grammarTopics.length) return '';

    const entries = [];
    const seen = new Set();

    if (vocabulary) {
      const href = vocabulary.page || `vocabulary.html?id=${encodeURIComponent(vocabulary.id)}`;
      const key = `vocab:${href}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          type: 'vocab',
          icon: '💥',
          label: 'Vocabulary',
          shortLabel: 'Vocab',
          title: safeText(vocabulary.title, 'Vocabulary'),
          href
        });
      }
    }

    grammarTopics.forEach((topic) => {
      if (topic.status === 'locked' || topic.status === 'draft') return;
      const href = topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`;
      const key = `grammar:${href}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({
        type: 'grammar',
        icon: '📐',
        label: 'Grammar',
        shortLabel: compactGrammarTitle(topic),
        title: safeText(topic.title, 'Grammar'),
        href
      });
    });

    if (!entries.length) return '';

    if (mode === 'hub') {
      const links = entries.map((entry) => `<a class="lesson-material-chip ${escapeHtml(entry.type)}" href="${escapeHtml(entry.href)}" aria-label="Open: ${escapeHtml(entry.label)} — ${escapeHtml(entry.title)}" title="${escapeHtml(entry.title)}"><span class="lesson-material-chip-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span class="lesson-material-chip-label">${escapeHtml(entry.shortLabel)}</span><span class="lesson-material-chip-arrow" aria-hidden="true">→</span></a>`).join('');
      return `<div class="lesson-materials lesson-materials-hub"><span class="lesson-materials-compact-label">Materials</span><div class="lesson-material-links">${links}</div></div>`;
    }

    const links = entries.map((entry) => `<a class="lesson-material-link ${escapeHtml(entry.type)}" href="${escapeHtml(entry.href)}"><span class="lesson-material-link-main"><span class="lesson-material-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span class="lesson-material-text"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.title)}</small></span></span><span class="lesson-material-arrow" aria-hidden="true">→</span></a>`).join('');
    return `<div class="lesson-materials lesson-materials-lesson"><div class="lesson-materials-heading"><span class="eyebrow">Open lesson materials</span><p>Vocabulary and grammar for this homework assignment.</p></div><div class="lesson-material-links">${links}</div></div>`;
  }

  function renderHomework() {
    const progress = window.ProgressService.loadHomeworkProgress();
    const published = HOMEWORK_DATA.filter((item) => item.status !== 'draft');
    const completed = published.filter((item) => progress.completedIds.includes(item.id) || item.status === 'completed').length;
    const percent = safePercent(completed, published.length);
    byId('hw-completed').textContent = completed;
    byId('hw-total').textContent = published.length;
    byId('hw-percent').textContent = `${percent}%`;
    byId('hw-overall-progress').innerHTML = progressMarkup('Overall progress', completed, published.length);
    const root = byId('homework-list');
    if (!published.length) {
      root.innerHTML = emptyState('📝', 'No homework assignments yet', 'The teacher will add an interactive assignment here after the first lesson.');
      return;
    }
    root.innerHTML = [...published].sort((a,b) => (a.number || 0) - (b.number || 0)).map((item) => {
      const locked = item.status === 'locked';
      const complete = progress.completedIds.includes(item.id) || item.status === 'completed';
      const title = locked ? '🔒 Coming soon' : safeText(item.title, 'Assignment');
      const subtitle = locked ? 'The material will open after the teacher publishes it.' : safeText(item.subtitle, 'Interactive assignment');
      const status = complete ? 'completed' : safeText(item.status, 'available');
      const label = complete ? 'Completed' : status === 'available' ? 'Available' : status === 'locked' ? 'Locked' : 'Draft';
      if (locked) {
        return `<article class="card lesson-hub-card disabled"><div class="lesson-hub-main"><div class="item-icon">🔒</div><div class="item-main"><span class="homework-number">Homework #${Number(item.number || 0)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><span class="status-badge status-locked">${escapeHtml(label)}</span></div></article>`;
      }
      const href = item.page || `lesson.html?id=${encodeURIComponent(item.id)}`;
      return `<article class="card lesson-hub-card">
        <a class="lesson-hub-main interactive" href="${escapeHtml(href)}">
          <div class="item-icon">${complete ? '✅' : '📝'}</div>
          <div class="item-main"><span class="homework-number">Homework #${Number(item.number || 0)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
          <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>
        </a>
        ${lessonMaterialLinks(item, 'hub')}
      </article>`;
    }).join('');
  }

  function renderGrammar() {
    const progress = window.ProgressService.loadGrammarProgress();
    const published = GRAMMAR_DATA.filter((topic) => topic.status !== 'draft');
    const passed = published.filter((topic) => progress.topics[topic.id]?.passed || topic.passed).length;
    byId('grammar-passed').textContent = passed;
    byId('grammar-total').textContent = published.length;
    byId('grammar-overall-progress').innerHTML = progressMarkup('Overall progress', passed, published.length, 'green');
    const root = byId('grammar-list');
    if (!published.length) {
      root.innerHTML = emptyState('📐', 'No grammar topics have been published yet', `Materials will be added in line with the lessons and the coursebook “${safeText(student.textbook)}”.`);
      return;
    }
    root.innerHTML = [...published].sort((a,b) => (a.order || 0) - (b.order || 0)).map((topic) => {
      const locked = topic.status === 'locked';
      const isPassed = progress.topics[topic.id]?.passed || topic.passed;
      const title = locked ? '🔒 Coming soon' : safeText(topic.title, 'Grammar topic');
      const tag = locked ? 'div' : 'a';
      const href = locked ? '' : ` href="${escapeHtml(topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`)}"`;
      return `<${tag} class="card item-card ${locked ? 'disabled' : 'interactive'}"${href}>
        <div class="item-icon">${isPassed ? '✅' : locked ? '🔒' : '📐'}</div>
        <div class="item-main"><h3>${escapeHtml(title)}</h3><p>${locked ? 'The material has not been published yet.' : `${escapeHtml(topic.level || student.level)} · ${Number(progress.topics[topic.id]?.attempts || topic.attempts || 0)} attempts`}</p></div>
        <span class="status-badge status-${isPassed ? 'completed' : locked ? 'locked' : 'available'}">${isPassed ? 'Completed' : locked ? 'Locked' : 'Open'}</span>
      </${tag}>`;
    }).join('');
  }

  function renderVocabularyHub() {
    const progress = window.ProgressService.loadVocabularyProgress();
    const totalWords = VOCABULARY_CATALOG.allWords.length;
    const knownCount = Object.entries(progress.words).filter(([wordKey, item]) => VOCABULARY_CATALOG.byKey.has(wordKey) && item.status === 'known').length;
    byId('vocab-known').textContent = knownCount;
    byId('vocab-total').textContent = totalWords;
    byId('vocab-topics').textContent = VOCABULARY_DATA.length;
    byId('vocab-percent').textContent = `${safePercent(knownCount, totalWords)}%`;
    byId('vocab-overall-progress').innerHTML = progressMarkup('Overall progress', knownCount, totalWords, 'rose');
    const root = byId('vocabulary-list');
    const filters = byId('vocab-filters');

    const draw = (filter = 'all') => {
      const filtered = VOCABULARY_DATA.filter((topic) => {
        const topicKnown = topic.words.filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
        const complete = topic.words.length > 0 && topicKnown >= topic.words.length;
        if (filter === 'completed') return complete;
        if (filter === 'lesson') return topic.type === 'lesson';
        if (filter === 'extra') return topic.type === 'extra';
        return true;
      });
      if (!filtered.length) {
        root.innerHTML = emptyState('💥', 'No vocabulary practice topics yet', 'New topics will appear after lessons. Duplicate words are excluded automatically.');
        return;
      }
      root.innerHTML = filtered.map((topic) => {
        const wordCount = topic.words.length;
        const topicKnown = topic.words.filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
        const complete = wordCount > 0 && topicKnown >= wordCount;
        return `<a class="card item-card interactive" href="${escapeHtml(topic.page || `vocabulary.html?id=${encodeURIComponent(topic.id)}`)}">
          <div class="item-icon">${escapeHtml(topic.icon || '💬')}</div>
          <div class="item-main"><h3>${escapeHtml(topic.title || 'Vocabulary topic')}</h3><p>${escapeHtml(topic.label || '')} · ${topicKnown} of ${wordCount} words</p></div>
          <span class="status-badge status-${complete ? 'completed' : 'available'}">${complete ? 'Completed' : 'Open'}</span>
        </a>`;
      }).join('');
    };
    if (filters) {
      filters.onclick = (event) => {
        const button = event.target.closest('[data-filter]');
        if (!button) return;
        filters.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
        draw(button.dataset.filter);
      };
    }
    draw();
  }

  function renderReadingSections(block) {
    const sections = Array.isArray(block.sections) ? block.sections : [];
    if (!sections.length) {
      const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');
      return `<div class="reading-copy-wrap"><p class="reading-copy">${text}</p></div>`;
    }
    return `<div class="reading-sections">${sections.map((section) => `<section class="reading-section">
      <div class="reading-section-heading"><span class="reading-number">${escapeHtml(section.number || '')}</span><h4>${escapeHtml(section.heading || '')}</h4></div>
      <p class="reading-section-copy">${escapeHtml(section.text || '')}</p>
    </section>`).join('')}</div>`;
  }

  function renderExerciseItem(item, blockId, index) {
    const itemId = safeText(item.id, `${index + 1}`);
    const number = item.number === undefined ? index + 1 : item.number;
    const prompt = escapeHtml(item.prompt || '');
    const inputId = `exercise-${blockId}-${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const numberMarkup = number === '' || number === null ? '' : `<span class="exercise-number">${escapeHtml(number)}</span>`;

    if (item.displayOnly) {
      const className = item.displayStyle === 'heading' ? 'exercise-display-heading' : 'exercise-display-copy';
      return `<div class="${className}" data-exercise-item="${escapeHtml(itemId)}">${prompt}</div>`;
    }

    if (item.example && item.input === 'odd-one-out') {
      const selectedIndex = Number(item.answer);
      const options = (item.options || []).map((option, optionIndex) => `<span class="odd-option ${optionIndex === selectedIndex ? 'selected' : ''}">${escapeHtml(option)}</span>`).join('');
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        <div class="exercise-control"><div class="odd-options">${options}</div><div class="odd-reason">The others are all <strong>${escapeHtml(item.reasonAnswer || '')}</strong>.</div></div>
      </div>`;
    }

    if (item.example) {
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        ${item.exampleTextOnly ? '' : `<div class="example-answer"><span>Example</span><strong>${escapeHtml(item.exampleAnswer || '')}</strong></div>`}
      </div>`;
    }

    let control = '';
    if (item.input === 'example-gap') {
      const segments = Array.isArray(item.segments) ? item.segments : [];
      control = `<div class="sentence-gaps numbered-example-gap"><span>${escapeHtml(segments[0] || '')}</span><span class="inline-example-answer"><b>${escapeHtml(item.exampleNumber || 1)}</b> ${escapeHtml(item.exampleAnswer || '')}</span><span>${escapeHtml(segments[1] || '')}</span><span class="inline-gap-number">${escapeHtml(item.gapNumber || 2)}</span><input class="gap-input" data-example-gap autocomplete="off"><span>${escapeHtml(segments[2] || '')}</span></div>`;
    } else if (item.input === 'odd-one-out') {
      control = `<div class="odd-one-out-control"><div class="odd-options">${(item.options || []).map((option, optionIndex) => `<label class="odd-option"><input type="radio" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div><label class="odd-reason" for="${escapeHtml(inputId)}-reason">The others are all <input class="gap-input odd-reason-input" id="${escapeHtml(inputId)}-reason" data-odd-reason autocomplete="off">.</label></div>`;
    } else if (item.input === 'multiple' || item.input === 'single') {
      const inputType = item.input === 'multiple' ? 'checkbox' : 'radio';
      control = `<div class="option-list compact-options">${(item.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div>`;
    } else if (item.input === 'select') {
      control = `<select id="${escapeHtml(inputId)}"><option value="">Choose an answer</option>${(item.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('')}</select>`;
    } else if (item.input === 'textarea') {
      control = `<textarea id="${escapeHtml(inputId)}" placeholder="${escapeHtml(item.placeholder || '')}"></textarea>`;
    } else if (item.input === 'gaps') {
      const answers = Array.isArray(item.answers) ? item.answers : [];
      const segments = Array.isArray(item.segments) ? item.segments : [];
      control = `<div class="sentence-gaps" aria-label="${prompt}">${answers.map((answer, gapIndex) => `${gapIndex < segments.length ? `<span>${escapeHtml(segments[gapIndex])}</span>` : ''}<input class="gap-input" data-gap-index="${gapIndex}" aria-label="Gap ${gapIndex + 1}" autocomplete="off">`).join('')}${segments.length > answers.length ? `<span>${escapeHtml(segments[segments.length - 1])}</span>` : ''}</div>`;
    } else {
      control = `<input class="text-field" id="${escapeHtml(inputId)}" autocomplete="off" placeholder="${escapeHtml(item.placeholder || '')}">`;
    }

    const itemHeader = numberMarkup || prompt
      ? `<div class="exercise-item-header">${numberMarkup}<label class="exercise-prompt" for="${escapeHtml(inputId)}">${prompt}</label></div>`
      : '';
    return `<div class="exercise-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="${escapeHtml(item.input || 'text')}">
      ${itemHeader}
      <div class="exercise-control">${control}</div>
      <div class="feedback" aria-live="polite"></div>
    </div>`;
  }

  function renderLessonBlock(block, index) {
    const id = safeText(block.id, `task-${index}`);
    const title = escapeHtml(block.title || block.prompt || `Task ${index + 1}`);
    const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');

    if (block.type === 'section') {
      return `<header id="lesson-section-${index}" class="lesson-section-title lesson-block" data-lesson-section><span class="lesson-section-step">${escapeHtml(block.__sectionNumber || index + 1)}</span><div><span class="eyebrow">${escapeHtml(block.eyebrow || 'Material')}</span><h2>${title}</h2>${text ? `<p class="muted">${text}</p>` : ''}</div></header>`;
    }
    if (block.type === 'info') return `<article class="card info-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'tip') return `<article class="card tip-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'reading') {
      const sectionCount = Array.isArray(block.sections) ? block.sections.length : 0;
      return `<article class="card lesson-block reading-card"><div class="reading-title"><div><span class="eyebrow">Reading</span><h3>${title}</h3></div>${sectionCount ? `<span class="reading-count">${sectionCount} sections</span>` : ''}</div>${renderReadingSections(block)}</article>`;
    }
    if (block.type === 'exercise') {
      const items = Array.isArray(block.items) ? block.items : [];
      const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
        ? `<div class="word-bank" aria-label="Word bank"><strong class="word-bank-label">Word bank</strong>${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
        : '';
      const wordBanks = Array.isArray(block.wordBanks) && block.wordBanks.length
        ? `<div class="word-bank-groups">${block.wordBanks.map((group) => `<div class="word-bank" aria-label="${escapeHtml(group.label || 'Word bank')}"><strong class="word-bank-label">${escapeHtml(group.label || 'Word bank')}</strong>${(group.words || []).map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`).join('')}</div>`
        : '';
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '';
      const imageEntries = Array.isArray(block.images) && block.images.length
        ? block.images
        : block.image
          ? [{ src: block.image, alt: block.imageAlt || '', label: '' }]
          : [];
      const image = imageEntries.length
        ? `<div class="exercise-images${imageEntries.length > 1 ? ' exercise-images-multiple' : ''}">${imageEntries.map((entry) => {
            const src = typeof entry === 'string' ? entry : entry?.src;
            const alt = typeof entry === 'string' ? '' : entry?.alt || '';
            const label = typeof entry === 'string' ? '' : entry?.label || '';
            if (!src) return '';
            return `<figure class="exercise-image-figure"><a class="exercise-image-link" href="${escapeHtml(src)}" target="_blank" rel="noopener"><img class="exercise-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"></a>${label ? `<figcaption>${escapeHtml(label)}</figcaption>` : ''}</figure>`;
          }).join('')}</div>`
        : '';
      const intro = block.introTitle || block.introText ? `<div class="exercise-source"><h4>${escapeHtml(block.introTitle || '')}</h4>${block.introText ? `<p>${escapeHtml(block.introText)}</p>` : ''}</div>` : '';
      return `<article class="card lesson-block exercise-card" data-task="${escapeHtml(id)}" data-type="exercise">
        <div class="exercise-heading"><span class="eyebrow">Exercise</span><h3>${title}</h3>${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}${player}${wordBank}${wordBanks}</div>
        ${image}${intro}
        <div class="exercise-items">${items.map((item, itemIndex) => renderExerciseItem(item, id, itemIndex)).join('')}</div>
      </article>`;
    }
    if (block.type === 'text' || block.type === 'translate') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><label class="field-label" for="${escapeHtml(id)}">${title}</label>${block.source ? `<p class="muted">${escapeHtml(block.source)}</p>` : ''}<input class="text-field" id="${escapeHtml(id)}" name="${escapeHtml(id)}" autocomplete="off"><div class="feedback"></div></article>`;
    if (block.type === 'textarea') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="textarea"><label class="field-label" for="${escapeHtml(id)}">${title}</label><textarea id="${escapeHtml(id)}" name="${escapeHtml(id)}"></textarea><div class="feedback"></div></article>`;
    if (block.type === 'single' || block.type === 'multiple') {
      const inputType = block.type === 'single' ? 'radio' : 'checkbox';
      const options = (block.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(id)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><h3>${title}</h3><div class="option-list">${options}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'select') {
      const options = (block.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="select"><label class="field-label" for="${escapeHtml(id)}">${title}</label><select id="${escapeHtml(id)}"><option value="">Choose an answer</option>${options}</select><div class="feedback"></div></article>`;
    }
    if (block.type === 'match') {
      const rights = (block.pairs || []).map((pair) => pair.right);
      const rows = (block.pairs || []).map((pair, pairIndex) => `<div>${escapeHtml(pair.left)}</div><select data-match-index="${pairIndex}"><option value="">Choose a match</option>${rights.map((right, rightIndex) => `<option value="${rightIndex}">${escapeHtml(right)}</option>`).join('')}</select>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="match"><h3>${title}</h3><div class="match-grid">${rows}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'reorder') {
      const chips = shuffled(block.words || []).map((word) => `<button class="word-chip" type="button" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="reorder"><h3>${title}</h3><div class="word-chips" data-reorder-source>${chips}</div><label class="field-label" for="${escapeHtml(id)}">Your sentence</label><input class="text-field" id="${escapeHtml(id)}" readonly><div class="feedback"></div></article>`;
    }
    if (block.type === 'audio') {
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '<p class="muted">The audio file has not been added yet.</p>';
      const response = block.response === false ? '' : `<input class="text-field" id="${escapeHtml(id)}" aria-label="Audio task answer"><div class="feedback"></div>`;
      const taskAttrs = block.response === false ? '' : ` data-task="${escapeHtml(id)}" data-type="audio"`;
      return `<article class="card lesson-block audio-card"${taskAttrs}><div class="audio-icon" aria-hidden="true">🎧</div><div class="audio-content"><h3>${title}</h3>${text ? `<p class="muted">${text}</p>` : ''}${player}${response}</div></article>`;
    }
    return '';
  }

  function normalizeAnswer(value) {
    return safeText(value)
      .normalize('NFKC')
      .replace(/[’‘`]/g, "'")
      .trim()
      .toLocaleLowerCase('en')
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  function textAnswerMatches(item, actual) {
    const accepted = Array.isArray(item.acceptedAnswers) && item.acceptedAnswers.length
      ? item.acceptedAnswers
      : Array.isArray(item.answer) ? item.answer : [item.answer];
    return accepted.some((answer) => normalizeAnswer(answer) !== '' && normalizeAnswer(answer) === normalizeAnswer(actual));
  }

  function checkExerciseItem(item, itemNode) {
    const inputType = item.input || 'text';
    let actual;
    let correct = false;

    if (inputType === 'example-gap') {
      actual = itemNode.querySelector('[data-example-gap]')?.value ?? '';
      correct = textAnswerMatches(item, actual);
    } else if (inputType === 'odd-one-out') {
      const selected = itemNode.querySelector('input[type="radio"]:checked')?.value ?? '';
      const reason = itemNode.querySelector('[data-odd-reason]')?.value ?? '';
      actual = { selected, reason };
      correct = selected !== ''
        && Number(selected) === Number(item.answer)
        && normalizeAnswer(reason) === normalizeAnswer(item.reasonAnswer);
    } else if (inputType === 'multiple') {
      actual = [...itemNode.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a, b) => a - b);
      const expected = [...(item.answer || [])].map(Number).sort((a, b) => a - b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (inputType === 'single') {
      actual = itemNode.querySelector('input:checked')?.value ?? '';
      correct = Number(actual) === Number(item.answer);
    } else if (inputType === 'select') {
      actual = itemNode.querySelector('select')?.value ?? '';
      correct = actual !== '' && Number(actual) === Number(item.answer);
    } else if (inputType === 'gaps') {
      actual = [...itemNode.querySelectorAll('[data-gap-index]')].map((input) => input.value);
      const expected = Array.isArray(item.answers) ? item.answers : [];
      correct = expected.length > 0 && expected.every((answer, index) => {
        const accepted = Array.isArray(answer) ? answer : [answer];
        return accepted.some((variant) => normalizeAnswer(variant) === normalizeAnswer(actual[index]));
      });
    } else {
      actual = itemNode.querySelector('input, textarea')?.value || '';
      correct = textAnswerMatches(item, actual);
    }

    return { actual, correct };
  }

  function checkExerciseBlock(block, node) {
    const actual = {};
    let correctCount = 0;
    let total = 0;

    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example || item.displayOnly) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const result = checkExerciseItem(item, itemNode);
      actual[itemId] = result.actual;
      const feedback = itemNode.querySelector('.feedback');

      if (item.scored === false) {
        itemNode.classList.remove('is-correct', 'is-wrong');
        itemNode.classList.add('is-saved');
        if (feedback) {
          feedback.className = 'feedback show neutral';
          feedback.textContent = 'Your answer has been saved for the teacher.';
        }
        return;
      }

      total += 1;
      if (result.correct) correctCount += 1;
      itemNode.classList.toggle('is-correct', result.correct);
      itemNode.classList.toggle('is-wrong', !result.correct);
      itemNode.classList.remove('is-saved');
      if (feedback) {
        feedback.className = `feedback show ${result.correct ? 'good' : 'bad'}`;
        feedback.textContent = result.correct ? 'Correct!' : safeText(item.explanation, 'Check the answer and try again.');
      }
    });

    return { actual, correctCount, total };
  }

  function checkLessonTask(block, node) {
    if (block.type === 'exercise') return checkExerciseBlock(block, node);
    let actual;
    let correct = false;
    if (block.type === 'single') {
      actual = node.querySelector('input:checked')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'multiple') {
      actual = [...node.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a,b) => a-b);
      const expected = [...(block.answer || [])].map(Number).sort((a,b) => a-b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (block.type === 'select') {
      actual = node.querySelector('select')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'match') {
      actual = [...node.querySelectorAll('[data-match-index]')].map((select) => Number(select.value));
      correct = actual.length > 0 && actual.every((value, index) => value === index);
    } else {
      actual = node.querySelector('input, textarea')?.value || '';
      if (Array.isArray(block.answer)) correct = block.answer.some((answer) => normalizeAnswer(answer) === normalizeAnswer(actual));
      else correct = normalizeAnswer(block.answer) !== '' && normalizeAnswer(block.answer) === normalizeAnswer(actual);
    }
    return { correctCount: correct ? 1 : 0, total: 1, actual };
  }

  function collectExerciseAnswers(block, node) {
    const actual = {};
    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example || item.displayOnly) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const inputType = item.input || 'text';
      if (inputType === 'example-gap') {
        actual[itemId] = itemNode.querySelector('[data-example-gap]')?.value ?? '';
      } else if (inputType === 'odd-one-out') {
        actual[itemId] = {
          selected: itemNode.querySelector('input[type="radio"]:checked')?.value ?? '',
          reason: itemNode.querySelector('[data-odd-reason]')?.value ?? ''
        };
      } else if (inputType === 'multiple') {
        actual[itemId] = [...itemNode.querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.value));
      } else if (inputType === 'single') {
        actual[itemId] = itemNode.querySelector('input[type="radio"]:checked')?.value ?? '';
      } else if (inputType === 'select') {
        actual[itemId] = itemNode.querySelector('select')?.value ?? '';
      } else if (inputType === 'gaps') {
        actual[itemId] = [...itemNode.querySelectorAll('[data-gap-index]')].map((input) => input.value);
      } else {
        actual[itemId] = itemNode.querySelector('input, textarea')?.value ?? '';
      }
    });
    return actual;
  }

  function collectLessonAnswers(root, blocks) {
    const answers = {};
    blocks.forEach((block, blockIndex) => {
      const taskId = safeText(block.id, `task-${blockIndex}`);
      const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
      if (!node) return;
      if (block.type === 'exercise') {
        answers[taskId] = collectExerciseAnswers(block, node);
      } else if (block.type === 'single') {
        answers[taskId] = node.querySelector('input[type="radio"]:checked')?.value ?? '';
      } else if (block.type === 'multiple') {
        answers[taskId] = [...node.querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.value));
      } else if (block.type === 'select') {
        answers[taskId] = node.querySelector('select')?.value ?? '';
      } else if (block.type === 'match') {
        answers[taskId] = [...node.querySelectorAll('[data-match-index]')].map((select) => select.value);
      } else {
        answers[taskId] = node.querySelector('input, textarea')?.value ?? '';
      }
    });
    return answers;
  }

  function restoreExerciseAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example || item.displayOnly) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const value = saved[itemId];
      if (value === undefined) return;
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const inputType = item.input || 'text';
      if (inputType === 'example-gap') {
        const input = itemNode.querySelector('[data-example-gap]');
        if (input) input.value = safeText(value);
      } else if (inputType === 'odd-one-out') {
        const selected = safeText(value?.selected);
        const input = itemNode.querySelector(`input[type="radio"][value="${CSS.escape(selected)}"]`);
        if (input) input.checked = true;
        const reason = itemNode.querySelector('[data-odd-reason]');
        if (reason) reason.value = safeText(value?.reason);
      } else if (inputType === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        itemNode.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (inputType === 'single') {
        const input = itemNode.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (inputType === 'select') {
        const select = itemNode.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (inputType === 'gaps') {
        const values = Array.isArray(value) ? value : [];
        itemNode.querySelectorAll('[data-gap-index]').forEach((input, gapIndex) => { input.value = safeText(values[gapIndex]); });
      } else {
        const input = itemNode.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  function restoreLessonAnswers(root, blocks, savedAnswers) {
    if (!savedAnswers || typeof savedAnswers !== 'object') return;
    blocks.forEach((block, index) => {
      const taskId = safeText(block.id, `task-${index}`);
      const value = savedAnswers[taskId];
      if (value === undefined) return;
      const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
      if (!node) return;
      if (block.type === 'exercise') {
        restoreExerciseAnswers(block, node, value);
      } else if (block.type === 'single') {
        const input = node.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (block.type === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        node.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (block.type === 'select') {
        const select = node.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (block.type === 'match') {
        const values = Array.isArray(value) ? value : [];
        node.querySelectorAll('[data-match-index]').forEach((select, matchIndex) => { select.value = safeText(values[matchIndex]); });
      } else {
        const input = node.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  async function renderLesson() {
    const id = queryParam('id');
    const lessonRecord = HOMEWORK_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('lesson-root');
    if (!lessonRecord || lessonRecord.status === 'locked') {
      root.innerHTML = emptyState('📝', 'The assignment has not been published yet', 'The teacher will add the material after the lesson.');
      return;
    }

    byId('lesson-hero-title').textContent = safeText(lessonRecord.title, 'Assignment');
    byId('lesson-hero-subtitle').textContent = `Homework #${Number(lessonRecord.number || 0)} · ${safeText(lessonRecord.subtitle, 'Interactive practice')}`;
    root.innerHTML = '<div class="card empty-state compact-empty"><div class="empty-state-icon">⏳</div><h3>Loading the assignment…</h3></div>';

    let lesson;
    try {
      lesson = await resolveLessonContent(lessonRecord);
    } catch (error) {
      console.error('Lesson content loading error:', error);
      root.innerHTML = emptyState('⚠️', 'Could not load the assignment', 'Check that the lesson JSON file exists in data/lessons and has the correct structure.');
      return;
    }

    const blocks = Array.isArray(lesson?.blocks) ? lesson.blocks : [];
    if (!blocks.length) {
      root.innerHTML = emptyState('📝', 'The assignment has not been published yet', 'The content will appear after the teacher prepares it.');
      return;
    }

    const progress = window.ProgressService.loadHomeworkProgress();
    const savedResult = progress.results[lesson.id];
    const pointsLabel = Number(lesson.totalPoints || 0) > 0 ? `${escapeHtml(lesson.totalPoints)} checked answers` : 'No automatic score';
    const hasManualResponses = blocks.some((block) => block.type === 'exercise' && (block.items || []).some((item) => item.scored === false));
    const lessonSections = blocks
      .map((block, blockIndex) => block.type === 'section' ? { block, blockIndex } : null)
      .filter(Boolean);
    const roadmap = lessonSections.length
      ? `<nav class="card lesson-roadmap" aria-label="Homework plan"><div class="lesson-roadmap-heading"><span class="eyebrow">Assignment plan</span><p>Complete the sections in order — your answers will be saved after checking.</p></div><ol>${lessonSections.map(({ block, blockIndex }, sectionIndex) => `<li><a href="#lesson-section-${blockIndex}"><span>${sectionIndex + 1}</span><strong>${escapeHtml(block.title || `Part ${sectionIndex + 1}`)}</strong></a></li>`).join('')}</ol></nav>`
      : '';
    let sectionNumber = 0;
    const renderedBlocks = blocks.map((block, blockIndex) => {
      if (block.type === 'section') sectionNumber += 1;
      return renderLessonBlock(block.type === 'section' ? { ...block, __sectionNumber: sectionNumber } : block, blockIndex);
    }).join('');
    const linkedMaterials = lessonMaterialLinks(lesson, 'lesson');
    root.innerHTML = `<div class="card lesson-intro"><div><span class="eyebrow">Homework #${Number(lesson.number || 0)}</span><p>${escapeHtml(lesson.subtitle || '')}</p></div><span class="lesson-points">${pointsLabel}</span></div>
      ${linkedMaterials}
      ${roadmap}
      <div id="lesson-blocks">${renderedBlocks}</div>
      <div class="card section lesson-actions"><div id="lesson-result" aria-live="polite"></div><div class="button-row"><button class="btn btn-primary" id="check-lesson" type="button">Check answers</button><button class="btn btn-secondary" id="submit-lesson" type="button" ${savedResult ? '' : 'disabled'}>Submit to teacher</button></div><p class="muted save-note">After checking, your answers are saved on this device and synced with Supabase.</p></div>`;

    restoreLessonAnswers(root, blocks, savedResult?.answers);

    root.querySelectorAll('[data-reorder-source]').forEach((source) => {
      source.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-word]');
        if (!chip) return;
        chip.classList.toggle('selected');
        const parent = source.closest('[data-task]');
        const input = parent.querySelector('input');
        const selected = [...source.querySelectorAll('.selected')].map((item) => item.dataset.word);
        input.value = selected.join(' ');
      });
    });

    // Save unfinished answers locally and to Supabase. A changed answer must be checked again.
    let draftTimer = 0;
    const queueDraftSave = () => {
      if (progress.submissions[lesson.id]) return;
      window.clearTimeout(draftTimer);
      const submitButton = byId('submit-lesson');
      if (submitButton) submitButton.disabled = true;
      draftTimer = window.setTimeout(() => {
        const latest = window.ProgressService.loadHomeworkProgress();
        const previous = latest.results[lesson.id] || {};
        latest.results[lesson.id] = {
          ...previous,
          correct: 0,
          total: 0,
          percent: 0,
          answers: collectLessonAnswers(root, blocks),
          checkedAt: new Date().toISOString()
        };
        window.ProgressService.saveHomeworkProgress(latest);
        const resultNode = byId('lesson-result');
        if (resultNode) resultNode.innerHTML = '<p class="muted">Draft saved. Check the answers before submitting.</p>';
      }, 500);
    };
    root.addEventListener('input', queueDraftSave);
    root.addEventListener('change', queueDraftSave);

    const evaluateLesson = () => {
      const checkableTypes = ['text','textarea','single','multiple','select','match','reorder','translate','audio','exercise'];
      const checkable = blocks
        .map((block, blockIndex) => ({ block, blockIndex }))
        .filter(({ block }) => checkableTypes.includes(block.type) && !(block.type === 'audio' && block.response === false));
      let correct = 0;
      let total = 0;
      const answers = {};

      checkable.forEach(({ block, blockIndex }) => {
        const taskId = safeText(block.id, `task-${blockIndex}`);
        const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
        if (!node) return;
        const result = checkLessonTask(block, node);
        answers[taskId] = result.actual;
        correct += Number(result.correctCount || 0);
        total += Number(result.total || 0);

        if (block.type !== 'exercise') {
          const feedback = node.querySelector('.feedback');
          const isCorrect = Number(result.correctCount || 0) === Number(result.total || 0);
          if (feedback) {
            feedback.className = `feedback show ${isCorrect ? 'good' : 'bad'}`;
            feedback.textContent = isCorrect ? 'Correct!' : safeText(block.explanation, 'Check the answer and try again.');
          }
        }
      });

      return { correct, total, percent: safePercent(correct, total), answers };
    };

    // Restore not only the values, but also the green/red review state after reload.
    if (savedResult && Number(savedResult.total) > 0) {
      evaluateLesson();
      byId('lesson-result').innerHTML = `<h3>Saved score: ${Number(savedResult.correct || 0)} of ${Number(savedResult.total || 0)}</h3><p class="muted">${Number(savedResult.percent || 0)}% correct</p>`;
    }

    byId('check-lesson').addEventListener('click', () => {
      const result = evaluateLesson();
      const manualNote = hasManualResponses ? ' · the extended answer is saved separately and is not included in the score' : '';
      byId('lesson-result').innerHTML = `<h3>Score: ${result.correct} of ${result.total}</h3><p class="muted">${result.percent}% correct${manualNote}</p>`;
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      updatedProgress.results[lesson.id] = {
        correct: result.correct,
        total: result.total,
        percent: result.percent,
        answers: result.answers,
        checkedAt: new Date().toISOString()
      };
      window.ProgressService.saveHomeworkProgress(updatedProgress);
      byId('submit-lesson').disabled = false;
    });

    byId('submit-lesson').addEventListener('click', async () => {
      const button = byId('submit-lesson');
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      const result = updatedProgress.results[lesson.id];
      if (!result || Number(result.total || 0) <= 0) {
        showToast('Check the answers before submitting the homework.');
        return;
      }

      const submittedAt = new Date().toISOString();
      updatedProgress.submissions[lesson.id] = {
        savedAt: submittedAt,
        status: CloudService.isConfigured() ? 'pending-cloud' : 'local'
      };
      // Submission, not a perfect score, marks the homework as completed.
      if (!updatedProgress.completedIds.includes(lesson.id)) updatedProgress.completedIds.push(lesson.id);
      window.ProgressService.saveHomeworkProgress(updatedProgress);

      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = 'Sending…';

      try {
        if (CloudService.isConfigured()) {
          // Wait until the submitted row is really written before the report function reads it.
          await window.ProgressService.syncToCloud('homework');
          const report = await HomeworkReportService.send(lesson.id);
          const latest = window.ProgressService.loadHomeworkProgress();
          latest.submissions[lesson.id] = {
            savedAt: submittedAt,
            status: report?.skipped ? 'cloud' : 'report-sent'
          };
          window.ProgressService.saveHomeworkProgress(latest);
          showToast(report?.skipped ? 'Homework saved in Supabase.' : 'Homework submitted. The teacher received the Telegram report.');
        } else {
          showToast('Homework saved on this device. Supabase is not configured.');
        }
      } catch (error) {
        console.error('Homework submission/report error:', error);
        const latest = window.ProgressService.loadHomeworkProgress();
        latest.submissions[lesson.id] = { savedAt: submittedAt, status: 'local-pending' };
        window.ProgressService.saveHomeworkProgress(latest);
        showToast(`Saved on this device, but Supabase sync failed. The site will retry: ${safeText(error?.message, 'unknown error')}`);
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  }

  
  function grammarTable(table) {
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return '';
    return `<div class="table-wrap"><table><thead><tr>${table.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderGrammarExercise(block, index) {
    const id = safeText(block.id, `grammar-exercise-${index + 1}`);
    const title = escapeHtml(block.title || `Exercise ${index + 1}`);
    const difficulty = safeText(block.difficulty, 'Practice');
    const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
      ? `<div class="word-bank" aria-label="Word bank"><strong class="word-bank-label">Word bank</strong>${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
      : '';
    return `<article class="card lesson-block exercise-card grammar-exercise-card" data-task="${escapeHtml(id)}" data-type="exercise" data-grammar-exercise="${index}">
      <div class="exercise-heading grammar-exercise-heading">
        <div class="grammar-step-row"><span class="grammar-step-badge">Step ${index + 1}</span><span class="grammar-difficulty">${escapeHtml(difficulty)}</span></div>
        <h3>${title}</h3>
        ${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}
        ${wordBank}
      </div>
      <div class="exercise-items">${(Array.isArray(block.items) ? block.items : []).map((item, itemIndex) => renderExerciseItem(item, id, itemIndex)).join('')}</div>
    </article>`;
  }

  function renderGrammarPractice(topic, root) {
    const exercises = Array.isArray(topic.exercises) ? topic.exercises : [];
    if (!exercises.length) {
      root.innerHTML = emptyState('🧩', 'Practice has not been added yet', 'Exercises will appear with the teacher’s material.');
      return;
    }

    const renderPractice = () => {
      root.innerHTML = `${exercises.map((block, index) => renderGrammarExercise(block, index)).join('')}
        <div class="card grammar-practice-actions">
          <div id="grammar-result"><h3>Practise step by step</h3><p class="muted">Start with the easier tasks and move on to the more challenging ones.</p></div>
          <div class="button-row"><button class="btn btn-primary" type="button" id="check-grammar">Check exercises</button><button class="btn btn-secondary" type="button" id="retry-grammar">Start again</button></div>
        </div>`;

      byId('check-grammar').addEventListener('click', () => {
        let correct = 0;
        let total = 0;
        exercises.forEach((block, index) => {
          const node = root.querySelector(`[data-grammar-exercise="${index}"]`);
          if (!node) return;
          const result = checkExerciseBlock(block, node);
          correct += Number(result.correctCount || 0);
          total += Number(result.total || 0);
        });
        const percent = safePercent(correct, total);
        byId('grammar-result').innerHTML = `<h3>Score: ${correct} of ${total}</h3><p class="muted">${percent}% correct</p>${percent === 100 ? '<p class="grammar-success-note">Excellent! You have mastered the topic and can move on.</p>' : '<p class="grammar-success-note">Review the tables and the Common mistakes section above, then try again.</p>'}`;
        const progress = window.ProgressService.loadGrammarProgress();
        const previous = progress.topics[topic.id] || {};
        progress.topics[topic.id] = {
          passed: percent === 100,
          attempts: Number(previous.attempts || 0) + 1,
          bestScore: Math.max(Number(previous.bestScore || 0), percent),
          updatedAt: new Date().toISOString()
        };
        window.ProgressService.saveGrammarProgress(progress);
      });

      byId('retry-grammar').addEventListener('click', renderPractice);
    };

    renderPractice();
  }

  function renderGrammarTopic() {
    const id = queryParam('id');
    const topic = GRAMMAR_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('grammar-topic-root');
    if (!topic || topic.status === 'locked') {
      root.innerHTML = emptyState('📐', 'This grammar topic has not been published yet', 'The material will appear after the teacher publishes it.');
      return;
    }

    byId('grammar-hero-title').textContent = safeText(topic.title, 'Grammar');
    byId('grammar-hero-subtitle').textContent = `${safeText(topic.level, student.level)} Level · explanations and practice`;

    const glanceCards = Array.isArray(topic.glanceCards) ? topic.glanceCards : [];
    const anchorLinks = Array.isArray(topic.anchorLinks) ? topic.anchorLinks : [];
    const miniRules = Array.isArray(topic.miniRules) ? topic.miniRules : [];
    const tables = Array.isArray(topic.tables) ? topic.tables : (topic.table ? [topic.table] : []);
    const exampleGroups = Array.isArray(topic.exampleGroups) ? topic.exampleGroups : [];
    const examples = Array.isArray(topic.examples) ? topic.examples : [];
    const mistakes = Array.isArray(topic.commonMistakes) ? topic.commonMistakes : [];

    root.innerHTML = `
      <article class="card grammar-intro-card">
        <span class="eyebrow">Grammar focus</span>
        <h2>${escapeHtml(topic.title)}</h2>
        <p class="muted grammar-lead">${escapeHtml(topic.explanation || '')}</p>
        ${topic.formula ? `<div class="grammar-formula-box"><strong>Quick formula</strong><p>${escapeHtml(topic.formula)}</p></div>` : ''}
        ${anchorLinks.length ? `<div class="grammar-anchor-links">${anchorLinks.map((link) => `<a class="grammar-anchor-link" href="#${escapeHtml(link.id)}">${escapeHtml(link.title)}</a>`).join('')}</div>` : ''}
      </article>

      ${glanceCards.length ? `<section class="section" id="grammar-at-a-glance" aria-labelledby="grammar-at-a-glance-title"><div class="section-heading"><div><span class="eyebrow">Quick overview</span><h2 id="grammar-at-a-glance-title">How to choose the right form quickly</h2></div></div><div class="grammar-glance-grid">${glanceCards.map((card) => `<article class="card grammar-glance-card"><div class="grammar-glance-head"><span class="grammar-glance-icon">${escapeHtml(card.icon || '✦')}</span><div><h3>${escapeHtml(card.label || '')}</h3><p class="muted">${escapeHtml(card.hint || '')}</p></div></div><div class="grammar-pattern">${escapeHtml(card.pattern || '')}</div><p class="grammar-example-sentence">${escapeHtml(card.example || '')}</p></article>`).join('')}</div></section>` : ''}

      ${miniRules.length ? `<section class="section" id="grammar-rule-map" aria-labelledby="grammar-rule-map-title"><div class="section-heading"><div><span class="eyebrow">Rule map</span><h2 id="grammar-rule-map-title">Step-by-step guide</h2></div></div><div class="grammar-mini-grid">${miniRules.map((rule) => `<article class="card grammar-mini-card"><h3>${escapeHtml(rule.title || '')}</h3><p>${escapeHtml(rule.text || '')}</p>${rule.example ? `<div class="grammar-mini-example">${escapeHtml(rule.example)}</div>` : ''}</article>`).join('')}</div></section>` : ''}

      ${tables.length ? `<section class="section" id="grammar-tables" aria-labelledby="grammar-tables-title"><div class="section-heading"><div><span class="eyebrow">Tables</span><h2 id="grammar-tables-title">Tables</h2></div></div><div class="list">${tables.map((table) => `<article class="card lesson-block"><h3>${escapeHtml(table.title || 'Table')}</h3>${grammarTable(table)}</article>`).join('')}</div></section>` : ''}

      ${exampleGroups.length || examples.length ? `<section class="section" id="grammar-examples" aria-labelledby="grammar-examples-title"><div class="section-heading"><div><span class="eyebrow">Examples</span><h2 id="grammar-examples-title">Examples in context</h2></div></div><div class="list">${exampleGroups.map((group) => `<article class="card lesson-block grammar-example-group"><h3>${escapeHtml(group.title || 'Examples')}</h3><div class="list">${(group.items || []).map((item) => `<p class="grammar-example-item">• ${escapeHtml(item)}</p>`).join('')}</div></article>`).join('')}${examples.length ? `<article class="card lesson-block grammar-example-group"><h3>More examples</h3><div class="list">${examples.map((example) => `<p class="grammar-example-item">• ${escapeHtml(example)}</p>`).join('')}</div></article>` : ''}</div></section>` : ''}

      ${mistakes.length ? `<section class="section" id="grammar-mistakes" aria-labelledby="grammar-mistakes-title"><div class="section-heading"><div><span class="eyebrow">Common mistakes</span><h2 id="grammar-mistakes-title">Common mistakes</h2></div></div><article class="card info-card lesson-block"><div class="list">${mistakes.map((mistake) => `<p>• ${escapeHtml(mistake)}</p>`).join('')}</div></article></section>` : ''}

      <section class="section" id="grammar-practice-section" aria-labelledby="grammar-practice-title"><div class="section-heading"><div><span class="eyebrow">Practice</span><h2 id="grammar-practice-title">${Array.isArray(topic.exercises) ? topic.exercises.length : 0} exercises: from easier to more challenging</h2></div></div><div id="grammar-quiz"></div></section>
    `;

    renderGrammarPractice(topic, byId('grammar-quiz'));
  }


  function getTopicProgress(progress, topicId) {
    if (!progress.topics[topicId]) progress.topics[topicId] = { tests: [] };
    if (!Array.isArray(progress.topics[topicId].tests)) progress.topics[topicId].tests = [];
    return progress.topics[topicId];
  }

  function setWordStatus(progress, word, topicId, status) {
    const now = new Date().toISOString();
    const previous = progress.words[word.__wordKey] || {};
    progress.words[word.__wordKey] = {
      status,
      topicId: previous.topicId || topicId,
      learnedAt: status === 'known' ? (previous.learnedAt || now) : null,
      updatedAt: now
    };
  }

  function renderVocabulary() {
    const id = queryParam('id');
    const topic = VOCABULARY_CATALOG.allTopics.find((item) => item.id === id);
    const root = byId('vocabulary-root');
    if (!topic || !Array.isArray(topic.words) || !topic.words.length) {
      root.innerHTML = emptyState('💥', 'No words have been added to this topic yet', 'The teacher will add the word list after the lesson. Words from earlier topics are not repeated here.');
      return;
    }
    byId('vocab-hero-title').textContent = safeText(topic.title, 'Vocabulary');
    byId('vocab-hero-subtitle').textContent = `${safeText(topic.label, 'Vocabulary topic')} · ${topic.words.length} unique words`;
    const progress = window.ProgressService.loadVocabularyProgress();
    const topicProgress = getTopicProgress(progress, topic.id);
    let mode = 'cards';
    let cardQueue = [];
    let testState = null;

    root.innerHTML = `<div class="mode-tabs" id="vocab-modes" aria-label="Practice mode">
      <button class="mode-btn active" type="button" data-mode="cards">New words</button>
      <button class="mode-btn" type="button" data-mode="test">Test</button>
      <button class="mode-btn" type="button" data-mode="all">All words</button>
      <button class="mode-btn" type="button" data-mode="difficult">Difficult words</button>
    </div><div id="vocab-mode-root" class="section"></div>`;
    const modeRoot = byId('vocab-mode-root');

    const save = () => window.ProgressService.saveVocabularyProgress(progress);
    const resetCardQueue = () => {
      cardQueue = shuffled(topic.words.filter((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return mode === 'difficult'
          ? status === 'difficult'
          : !['known', 'reviewed', 'difficult'].includes(status);
      }));
    };

    const drawCard = () => {
      if (!cardQueue.length) {
        const isDifficult = mode === 'difficult';
        modeRoot.innerHTML = emptyState(
          isDifficult ? '🌟' : '🎉',
          isDifficult ? 'No difficult words yet' : 'You have reviewed all new words in this topic',
          isDifficult ? 'Mark a word as “Difficult” and it will appear here.' : 'A word is marked as learned only after a correct answer in the test.'
        );
        return;
      }
      const word = cardQueue[0];
      const remaining = cardQueue.length;
      modeRoot.innerHTML = `<div class="flash-counter">Remaining: ${remaining}</div><div class="flashcard-stage"><div class="flashcard" id="flashcard" tabindex="0" role="button" aria-label="Flip the card">
        <div class="flash-face flash-front"><div class="flash-word">${escapeHtml(word.en)}</div>${word.transcription ? `<div class="flash-transcription">${escapeHtml(word.transcription)}</div>` : ''}<p class="muted">Tap to see the translation</p></div>
        <div class="flash-face flash-back"><div class="flash-word">${escapeHtml(word.ru)}</div>${word.exampleEn ? `<p class="flash-example">${escapeHtml(word.exampleEn)}${word.exampleRu ? `<br>${escapeHtml(word.exampleRu)}` : ''}</p>` : ''}</div>
      </div></div><div class="trainer-actions"><button class="btn btn-danger" id="word-difficult" type="button">Difficult</button><button class="btn btn-success" id="word-known" type="button">Reviewed</button></div>`;
      const flashcard = byId('flashcard');
      const flip = () => flashcard.classList.toggle('flipped');
      flashcard.addEventListener('click', flip);
      flashcard.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
      byId('word-known').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'reviewed');
        cardQueue.shift();
        save();
        drawCard();
      });
      byId('word-difficult').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'difficult');
        cardQueue.shift();
        save();
        drawCard();
      });
    };

    const startTest = () => {
      if (topic.words.length < 4) {
        modeRoot.innerHTML = emptyState('🧩', 'At least 4 words are needed for the test', 'Add more unique words to the topic to create four answer options.');
        return;
      }
      testState = { words: shuffled(topic.words), index: 0, firstTryCorrect: 0, answered: false, firstAnswers: {} };
      drawQuestion();
    };

    const finishTest = () => {
      const result = {
        score: testState.firstTryCorrect,
        total: testState.words.length,
        percent: safePercent(testState.firstTryCorrect, testState.words.length),
        answers: testState.firstAnswers,
        completedAt: new Date().toISOString()
      };
      topicProgress.tests.push(result);
      save();
      modeRoot.innerHTML = `<div class="card empty-state"><div class="empty-state-icon">🏁</div><h3>Test complete</h3><p>First-try score: ${result.score} of ${result.total}</p><div class="button-row" style="justify-content:center"><button class="btn btn-primary" id="restart-vocab-test" type="button">Try again</button></div></div>`;
      byId('restart-vocab-test').addEventListener('click', startTest);
    };

    const drawQuestion = () => {
      if (testState.index >= testState.words.length) { finishTest(); return; }
      const word = testState.words[testState.index];
      const distractors = shuffled(topic.words.filter((item) => item.__wordKey !== word.__wordKey)).slice(0, 3);
      const options = shuffled([word, ...distractors]);
      testState.answered = false;
      modeRoot.innerHTML = `<div class="flash-counter">Question ${testState.index + 1} of ${testState.words.length}</div><article class="card"><span class="eyebrow">Choose the translation</span><h2 class="flash-word">${escapeHtml(word.en)}</h2>${word.transcription ? `<p class="muted">${escapeHtml(word.transcription)}</p>` : ''}<div class="option-list section">${options.map((option) => `<button class="quiz-option" type="button" data-answer-key="${escapeHtml(option.__wordKey)}">${escapeHtml(option.ru)}</button>`).join('')}</div><div id="vocab-test-feedback" class="feedback"></div><div class="button-row"><button class="btn btn-primary" id="next-vocab-question" type="button" disabled>Next word</button></div></article>`;
      modeRoot.querySelectorAll('[data-answer-key]').forEach((button) => {
        button.addEventListener('click', () => {
          if (testState.answered) return;
          testState.answered = true;
          const correct = button.dataset.answerKey === word.__wordKey;
          testState.firstAnswers[word.__wordKey] = { correct, selected: button.dataset.answerKey };
          if (correct) {
            testState.firstTryCorrect += 1;
            setWordStatus(progress, word, topic.id, 'known');
          } else {
            setWordStatus(progress, word, topic.id, 'difficult');
          }
          save();
          modeRoot.querySelectorAll('[data-answer-key]').forEach((optionButton) => {
            optionButton.disabled = true;
            if (optionButton.dataset.answerKey === word.__wordKey) optionButton.classList.add('correct');
          });
          if (!correct) button.classList.add('wrong');
          const feedback = byId('vocab-test-feedback');
          feedback.className = `feedback show ${correct ? 'good' : 'bad'}`;
          feedback.textContent = correct ? 'Correct on the first try!' : `Correct answer: ${word.ru}`;
          byId('next-vocab-question').disabled = false;
        });
      });
      byId('next-vocab-question').addEventListener('click', () => { testState.index += 1; drawQuestion(); });
    };

    const drawAllWords = () => {
      modeRoot.innerHTML = `<div class="words-grid">${topic.words.map((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return `<article class="card word-card ${status === 'known' ? 'known' : ''} ${status === 'difficult' ? 'difficult' : ''}"><strong>${escapeHtml(word.en)}</strong><span>${escapeHtml(word.ru)}</span>${word.transcription ? `<span>${escapeHtml(word.transcription)}</span>` : ''}</article>`;
      }).join('')}</div>`;
    };

    const drawMode = () => {
      if (mode === 'cards' || mode === 'difficult') {
        resetCardQueue();
        drawCard();
      } else if (mode === 'test') startTest();
      else drawAllWords();
    };
    byId('vocab-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      mode = button.dataset.mode;
      byId('vocab-modes').querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
      drawMode();
    });
    drawMode();
  }

  async function refreshCurrentView() {
    const view = document.body.dataset.view;
    const renderers = {
      home: renderHome,
      homework: renderHomework,
      grammar: renderGrammar,
      'vocabulary-hub': renderVocabularyHub,
      lesson: renderLesson,
      'grammar-topic': renderGrammarTopic,
      vocabulary: renderVocabulary
    };
    try {
      await renderers[view]?.();
    } catch (error) {
      console.error('Page rendering error:', error);
      const main = document.querySelector('main');
      if (main) main.innerHTML = emptyState('⚠️', 'Could not open the page', 'Check the data structure and refresh the page.');
    }
  }

  async function init() {
    fillConfig();
    migrateLegacyLocalProgress();
    markNavigation();
    try {
      await loadHomeworkData();
    } catch (error) {
      console.error('Lesson catalogue loading error:', error);
      HOMEWORK_DATA = [];
      window.HOMEWORK_DATA = HOMEWORK_DATA;
    }
    await refreshCurrentView();
    if (!CloudService.isConfigured()) return;
    try {
      await CloudService.init();
      await window.ProgressService.syncFromCloud();
      await refreshCurrentView();
    } catch (error) {
      console.error('Supabase connection error:', error);
      const detail = safeText(error?.message || error?.details || error?.hint);
      showToast(detail ? `Supabase error: ${detail}` : 'Supabase is temporarily unavailable.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
