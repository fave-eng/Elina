import { withSupabase } from 'npm:@supabase/server@^1'

const encoder = new TextEncoder()
const FUNCTION_VERSION = 'homework-reports-v7-elina-notification-style-topic-13'
const DIAGNOSTIC_VERSION = 'elina-diagnostics-v2-topic-13'
const diagnosticSendAttempts = new Map<string, number>()
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  const responseBody = body && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), functionVersion: FUNCTION_VERSION }
    : body
  return Response.json(responseBody, { status, headers: corsHeaders })
}

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false

  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index]
  }
  return diff === 0
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const MOTIVATION_LINES = [
  'Keep going — you’re doing great! 💪',
  'Small steps still move you forward. ✨',
  'You are building real English skills. 🌱',
  'One task at a time. You’ve got this. 🚀',
  'Today’s practice makes tomorrow easier. 💫',
  'Stay consistent — it works. ⭐',
]

function randomMotivation(): string {
  return MOTIVATION_LINES[Math.floor(Math.random() * MOTIVATION_LINES.length)] || 'Keep going — you’re doing great! 💪'
}

function buildMaterialMessage(homeworkTitle: unknown, hasVocabulary: boolean, grammarCount: number): string {
  const title = String(homeworkTitle || 'Homework').trim()
  const steps: string[] = []

  if (hasVocabulary) steps.push('First, learn the new words.')
  if (grammarCount > 0) steps.push(`${hasVocabulary ? 'Next' : 'First'}, read the grammar.`)
  steps.push(`${hasVocabulary || grammarCount > 0 ? 'Then' : 'Open the homework and'}, do the homework.`)

  return [
    'Hi! 👋',
    '',
    'Your new English homework is ready.',
    '',
    `📘 <b>${escapeHtml(title)}</b>`,
    '',
    ...steps,
    '',
    escapeHtml(randomMotivation()),
  ].join('\n')
}

function buildHomeworkReport(row: any): string {
  const correct = Number(row.score_correct || 0)
  const total = Number(row.score_total || 0)
  const percent = Number(row.score_percent ?? (total > 0 ? Math.round((correct / total) * 100) : 0))
  const mistakes = Math.max(0, total - correct)
  const submittedAt = row.submitted_at || row.updated_at || row.checked_at
  const submittedLabel = submittedAt
    ? new Date(submittedAt).toLocaleString('en-GB', { timeZone: 'Asia/Yekaterinburg' })
    : 'not specified'

  return [
    '📩 <b>Homework report received</b>',
    '',
    `📝 Homework: <b>${escapeHtml(row.lesson_title || row.lesson_id)}</b>`,
    `✅ Score: <b>${correct} / ${total} (${percent}%)</b>`,
    `❌ Mistakes: <b>${mistakes}</b>`,
    `🕒 Submitted: ${escapeHtml(submittedLabel)}`,
    '',
    'Answers and results were saved in Supabase.',
  ].join('\n')
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  threadId: number | null,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; url: string }>> = [],
) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  }
  if (typeof threadId === 'number' && Number.isFinite(threadId)) payload.message_thread_id = threadId
  if (inlineKeyboard.length) payload.reply_markup = { inline_keyboard: inlineKeyboard }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    const description = result?.description || `Telegram HTTP ${response.status}`
    throw new Error(description)
  }

  return result.result
}

async function getRecipient(ctx: any, studentId: string) {
  const { data: recipient, error } = await ctx.supabaseAdmin
    .from('telegram_recipients')
    .select('chat_id, message_thread_id, enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (error) throw error
  if (!recipient || !recipient.enabled) {
    const notFound = new Error('Telegram recipient is not connected or is disabled')
    ;(notFound as any).status = 404
    throw notFound
  }
  return recipient
}

async function handleHomeworkReport(payload: any, ctx: any, botToken: string) {
  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
  const lessonUrl = isHttpUrl(payload.lessonUrl) ? payload.lessonUrl : ''

  if (!studentId || !lessonId) {
    return json({ ok: false, error: 'studentId and lessonId are required' }, 400)
  }

  let recipient
  try {
    recipient = await getRecipient(ctx, studentId)
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, (error as any)?.status || 500)
  }

  const { data: row, error: progressError } = await ctx.supabaseAdmin
    .from('homework_progress')
    .select('student_id, student_name, lesson_id, lesson_title, status, answers, score_correct, score_total, score_percent, checked_at, submitted_at, locked_at, report_status, report_sent_at, updated_at')
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)
    .maybeSingle()

  if (progressError) return json({ ok: false, error: progressError.message }, 500)
  if (!row || Number(row.score_total || 0) <= 0 || !row.checked_at) {
    return json({ ok: false, error: 'A checked homework row was not found in homework_progress' }, 409)
  }

  if (row.status === 'submitted' && row.report_status === 'sent' && row.report_sent_at) {
    return json({
      ok: true,
      skipped: true,
      reason: 'already_sent',
      submittedAt: row.submitted_at || row.locked_at || row.report_sent_at,
      reportSentAt: row.report_sent_at,
    })
  }

  // Atomically claim the report. This prevents a double tap from sending
  // two Telegram messages for the same checked homework.
  const { data: claimedRow, error: pendingError } = await ctx.supabaseAdmin
    .from('homework_progress')
    .update({ report_status: 'pending', report_error: null, updated_at: new Date().toISOString() })
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)
    .in('report_status', ['not_sent', 'failed'])
    .select('student_id')
    .maybeSingle()

  if (pendingError) return json({ ok: false, error: pendingError.message }, 500)
  if (!claimedRow) {
    return json({ ok: false, error: 'The report is already being sent. Please wait and try again.' }, 409)
  }

  const submittedAt = new Date().toISOString()
  const reportRow = { ...row, submitted_at: submittedAt }
  const keyboard = lessonUrl
    ? [[{ text: '📝 Open homework', url: lessonUrl }]]
    : []

  let telegramMessage: any
  try {
    telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
      recipient.message_thread_id == null ? null : Number(recipient.message_thread_id),
      buildHomeworkReport(reportRow),
      keyboard,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ctx.supabaseAdmin
      .from('homework_progress')
      .update({ report_status: 'failed', report_error: message })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    return json({ ok: false, error: message }, 502)
  }

  const reportSentAt = new Date().toISOString()
  const { error: finalizeError } = await ctx.supabaseAdmin
    .from('homework_progress')
    .update({
      status: 'submitted',
      submitted_at: submittedAt,
      locked_at: submittedAt,
      report_status: 'sent',
      report_sent_at: reportSentAt,
      report_error: null,
      updated_at: reportSentAt,
    })
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)

  if (finalizeError) {
    return json({
      ok: false,
      telegramSent: true,
      telegramMessageId: telegramMessage?.message_id,
      error: `Telegram was sent, but homework finalization failed: ${finalizeError.message}`,
    }, 500)
  }

  return json({
    ok: true,
    skipped: false,
    telegramMessageId: telegramMessage?.message_id,
    submittedAt,
    reportSentAt,
  })
}


async function fetchTelegramJson(token: string, method: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => null)
  return {
    ok: Boolean(response.ok && data?.ok),
    status: response.status,
    data,
    error: data?.description || (response.ok ? '' : `Telegram HTTP ${response.status}`),
  }
}

function isDiagnosticKind(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('diagnostics_')
}

function validateDiagnosticStudent(payload: any) {
  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim().toLowerCase() : ''
  if (studentId !== 'elina') {
    const error = new Error('Diagnostics are allowed only for student_id=elina')
    ;(error as any).status = 403
    throw error
  }
  return studentId
}

async function readDiagnosticRecipient(ctx: any, studentId: string) {
  const { data: recipient, error } = await ctx.supabaseAdmin
    .from('telegram_recipients')
    .select('chat_id, message_thread_id, enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message, enabled: false, source: 'telegram_recipients', threadId: null }
  if (!recipient) return { ok: false, error: 'Recipient row was not found', enabled: false, source: 'telegram_recipients', threadId: null }
  if (!recipient.enabled) return { ok: false, error: 'Recipient is disabled', enabled: false, source: 'telegram_recipients', threadId: null }
  return {
    ok: true,
    source: 'telegram_recipients',
    enabled: Boolean(recipient.enabled),
    chatId: Number(recipient.chat_id),
    threadId: recipient.message_thread_id == null ? null : Number(recipient.message_thread_id),
  }
}

async function handleDiagnostics(payload: any, ctx: any, botToken: string) {
  let studentId = 'elina'
  try {
    studentId = validateDiagnosticStudent(payload)
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error), diagnosticVersion: DIAGNOSTIC_VERSION }, (error as any)?.status || 403)
  }

  if (payload.kind === 'diagnostics_health') {
    let rows: any[] = []
    let database: Record<string, unknown> = { ok: false, homeworkRows: 0 }
    const { data, error } = await ctx.supabaseAdmin
      .from('homework_progress')
      .select('lesson_id,status')
      .eq('student_id', studentId)
      .limit(200)

    if (error) {
      database = { ok: false, homeworkRows: 0, error: error.message }
    } else {
      rows = data || []
      const workingRows = rows.filter((row) => !String(row.lesson_id || '').startsWith('__diagnostic_probe__'))
      const suspicious = workingRows
        .filter((row) => !['draft', 'checked', 'submitted'].includes(String(row.status || '')))
        .map((row) => `${row.lesson_id}: ${row.status}`)
      const staleDiagnosticProbes = rows.filter((row) => String(row.lesson_id || '').startsWith('__diagnostic_probe__'))
      let staleDiagnosticProbesRemoved = 0
      if (staleDiagnosticProbes.length) {
        const { error: deleteError } = await ctx.supabaseAdmin
          .from('homework_progress')
          .delete()
          .eq('student_id', studentId)
          .like('lesson_id', '__diagnostic_probe__%')
        if (!deleteError) staleDiagnosticProbesRemoved = staleDiagnosticProbes.length
      }
      database = {
        ok: true,
        homeworkRows: workingRows.length,
        suspiciousHomework: suspicious,
        staleDiagnosticProbesRemoved,
      }
    }

    const recipient = await readDiagnosticRecipient(ctx, studentId)
    const telegram: Record<string, unknown> = {
      bot: { ok: false, error: 'Not checked' },
      chat: { ok: false, error: 'Not checked' },
    }

    const bot = await fetchTelegramJson(botToken, 'getMe')
    telegram.bot = bot.ok
      ? { ok: true, username: bot.data?.result?.username || null }
      : { ok: false, error: bot.error || 'getMe failed' }

    if (recipient.ok && typeof recipient.chatId === 'number') {
      const chat = await fetchTelegramJson(botToken, 'getChat', { chat_id: recipient.chatId })
      telegram.chat = chat.ok
        ? { ok: true, type: chat.data?.result?.type || null, title: chat.data?.result?.title || null }
        : { ok: false, error: chat.error || 'getChat failed' }
    }

    return json({
      ok: true,
      diagnosticVersion: DIAGNOSTIC_VERSION,
      database,
      recipient,
      telegram,
    })
  }

  if (payload.kind === 'diagnostics_homework_probe') {
    const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
    if (!lessonId.startsWith('__diagnostic_probe__')) return json({ ok: false, error: 'Invalid diagnostic lessonId', diagnosticVersion: DIAGNOSTIC_VERSION }, 400)
    const now = new Date().toISOString()
    const { data: before, error: readError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .select('student_id,lesson_id,status,score_correct,score_total')
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
      .maybeSingle()
    if (readError) return json({ ok: false, error: readError.message, diagnosticVersion: DIAGNOSTIC_VERSION }, 500)
    if (!before) return json({ ok: false, error: 'Probe row was not found after browser insert', diagnosticVersion: DIAGNOSTIC_VERSION }, 404)

    const { error: submitError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .update({
        status: 'submitted',
        submitted_at: now,
        locked_at: now,
        report_status: 'sent',
        report_sent_at: now,
        report_error: null,
        updated_at: now,
      })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    if (submitError) return json({ ok: false, error: submitError.message, diagnosticVersion: DIAGNOSTIC_VERSION }, 500)

    const { error: cleanupError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .delete()
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    if (cleanupError) return json({ ok: false, error: cleanupError.message, diagnosticVersion: DIAGNOSTIC_VERSION }, 500)

    return json({
      ok: true,
      diagnosticVersion: DIAGNOSTIC_VERSION,
      stages: ['browser_checked_insert_seen', 'service_role_submitted_update', 'service_role_cleanup_delete'],
    })
  }

  if (payload.kind === 'diagnostics_cleanup_probe') {
    const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
    if (lessonId.startsWith('__diagnostic_probe__')) {
      await ctx.supabaseAdmin
        .from('homework_progress')
        .delete()
        .eq('student_id', studentId)
        .eq('lesson_id', lessonId)
    }
    return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION })
  }

  if (payload.kind === 'diagnostics_send_report') {
    const last = diagnosticSendAttempts.get(studentId) || 0
    const nowMs = Date.now()
    const diffSeconds = Math.floor((nowMs - last) / 1000)
    if (last && diffSeconds < 30) {
      return json({ ok: true, skipped: true, retryAfterSeconds: 30 - diffSeconds, diagnosticVersion: DIAGNOSTIC_VERSION })
    }

    const recipient = await readDiagnosticRecipient(ctx, studentId)
    if (!recipient.ok || typeof recipient.chatId !== 'number') {
      return json({ ok: false, error: recipient.error || 'Telegram recipient is not connected', diagnosticVersion: DIAGNOSTIC_VERSION }, 404)
    }

    const pageUrl = isHttpUrl(payload.pageUrl) ? payload.pageUrl : ''
    const text = [
      '🧪 <b>Diagnostics test message</b>',
      '',
      'The website can reach Telegram successfully.',
      pageUrl ? `Page: ${escapeHtml(pageUrl)}` : '',
    ].filter(Boolean).join('\n')

    try {
      const message = await sendTelegramMessage(botToken, recipient.chatId, recipient.threadId == null ? null : Number(recipient.threadId), text)
      diagnosticSendAttempts.set(studentId, nowMs)
      return json({
        ok: true,
        skipped: false,
        diagnosticVersion: DIAGNOSTIC_VERSION,
        telegramMessageId: message?.message_id,
        threadId: recipient.threadId ?? null,
      })
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error), diagnosticVersion: DIAGNOSTIC_VERSION }, 502)
    }
  }

  return json({ ok: false, error: 'Unknown diagnostics request', diagnosticVersion: DIAGNOSTIC_VERSION }, 400)
}

async function handleMaterialNotification(payload: any, req: Request, ctx: any, botToken: string) {
  const expectedSecret = Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? ''
  const actualSecret = req.headers.get('x-notify-secret') ?? ''
  if (!expectedSecret || !secureEqual(actualSecret, expectedSecret)) {
    return json({ ok: false, error: 'Unauthorized' }, 401)
  }

  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  const materialType = typeof payload.materialType === 'string' ? payload.materialType.trim() : ''
  const materialId = typeof payload.materialId === 'string' ? payload.materialId.trim() : ''
  const notificationVersion = Number(payload.notificationVersion)
  const homework = payload.homework
  const vocabulary = payload.vocabulary
  const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

  if (!studentId || !materialType || !materialId || !Number.isInteger(notificationVersion) || notificationVersion < 1) {
    return json({ ok: false, error: 'Missing or invalid notification identity' }, 400)
  }
  if (!homework || !isHttpUrl(homework.url)) return json({ ok: false, error: 'A valid homework URL is required' }, 400)
  if (vocabulary && !isHttpUrl(vocabulary.url)) return json({ ok: false, error: 'Invalid vocabulary URL' }, 400)
  for (const item of grammar) {
    if (!item || !isHttpUrl(item.url)) return json({ ok: false, error: 'Invalid grammar URL' }, 400)
  }

  let recipient
  try {
    recipient = await getRecipient(ctx, studentId)
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, (error as any)?.status || 500)
  }

  const { data: existing, error: existingError } = await ctx.supabaseAdmin
    .from('material_publications')
    .select('id, status, telegram_message_id')
    .eq('student_id', studentId)
    .eq('material_type', materialType)
    .eq('material_id', materialId)
    .eq('notification_version', notificationVersion)
    .maybeSingle()

  if (existingError) return json({ ok: false, error: existingError.message }, 500)
  if (existing?.status === 'sent') {
    return json({ ok: true, skipped: true, reason: 'already_sent', telegramMessageId: existing.telegram_message_id })
  }

  let publicationId = existing?.id as string | undefined
  if (publicationId) {
    const { error } = await ctx.supabaseAdmin
      .from('material_publications')
      .update({ status: 'pending', payload, error_message: null })
      .eq('id', publicationId)
    if (error) return json({ ok: false, error: error.message }, 500)
  } else {
    const { data: created, error } = await ctx.supabaseAdmin
      .from('material_publications')
      .insert({
        student_id: studentId,
        material_type: materialType,
        material_id: materialId,
        notification_version: notificationVersion,
        status: 'pending',
        payload,
      })
      .select('id')
      .single()

    if (error) {
      if (error.code === '23505') return json({ ok: true, skipped: true, reason: 'already_claimed' })
      return json({ ok: false, error: error.message }, 500)
    }
    publicationId = created.id
  }

  const keyboard: Array<Array<{ text: string; url: string }>> = []
  if (vocabulary) keyboard.push([{ text: '📚 Learn new words', url: vocabulary.url }])
  grammar.forEach((item: any, index: number) => {
    keyboard.push([{ text: `📖 Grammar ${index + 1}`, url: item.url }])
  })
  keyboard.push([{ text: '📝 Do the homework', url: homework.url }])

  try {
    const telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
      recipient.message_thread_id == null ? null : Number(recipient.message_thread_id),
      buildMaterialMessage(homework.title, Boolean(vocabulary), grammar.length),
      keyboard,
    )

    const { error: updateError } = await ctx.supabaseAdmin
      .from('material_publications')
      .update({
        status: 'sent',
        telegram_message_id: telegramMessage.message_id,
        sent_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', publicationId)

    if (updateError) throw new Error(`Telegram sent, but log update failed: ${updateError.message}`)
    return json({ ok: true, skipped: false, telegramMessageId: telegramMessage.message_id })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ctx.supabaseAdmin
      .from('material_publications')
      .update({ status: 'failed', error_message: message })
      .eq('id', publicationId)
    return json({ ok: false, error: message }, 502)
  }
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    if (!botToken) return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)

    let payload: any
    try {
      payload = await req.json()
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400)
    }

    if (isDiagnosticKind(payload?.kind)) {
      return handleDiagnostics(payload, ctx, botToken)
    }

    if (payload?.eventType === 'homework_report') {
      return handleHomeworkReport(payload, ctx, botToken)
    }
    return handleMaterialNotification(payload, req, ctx, botToken)
  }),
}
