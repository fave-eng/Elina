import { withSupabase } from 'npm:@supabase/server@^1'

const encoder = new TextEncoder()
const FUNCTION_VERSION = 'homework-reports-v5-elina-final'
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

function buildMaterialMessage(hasVocabulary: boolean): string {
  if (hasVocabulary) {
    return [
      '🚀 <b>New learning materials are available!</b>',
      '',
      'Start with the lesson vocabulary — it will make the homework easier. Then continue to the assignment.',
      '',
      'Good luck! Note any questions and we will discuss them in the next lesson ✨',
    ].join('\n')
  }

  return [
    '🚀 <b>New learning materials are available!</b>',
    '',
    'Continue to the homework assignment. Note any questions and we will discuss them in the next lesson.',
    '',
    'Good luck! ✨',
  ].join('\n')
}

function buildHomeworkReport(row: any): string {
  const correct = Number(row.score_correct || 0)
  const total = Number(row.score_total || 0)
  const percent = Number(row.score_percent ?? (total > 0 ? Math.round((correct / total) * 100) : 0))
  const mistakes = Math.max(0, total - correct)
  const submittedAt = row.submitted_at || row.updated_at || row.checked_at
  const submittedLabel = submittedAt
    ? new Date(submittedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })
    : 'не указано'

  return [
    '📩 <b>Получен отчёт по домашней работе</b>',
    '',
    `👩‍🎓 Ученица: <b>${escapeHtml(row.student_name || 'Ученица')}</b>`,
    `📝 Работа: <b>${escapeHtml(row.lesson_title || row.lesson_id)}</b>`,
    `✅ Результат: <b>${correct} из ${total} (${percent}%)</b>`,
    `❌ Ошибок: <b>${mistakes}</b>`,
    `🕒 Отправлено: ${escapeHtml(submittedLabel)}`,
    '',
    'Ответы и результат сохранены в Supabase.',
  ].join('\n')
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; url: string }>> = [],
) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  }
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
    .select('chat_id, enabled')
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
    ? [[{ text: '📝 Открыть домашнюю работу', url: lessonUrl }]]
    : []

  let telegramMessage: any
  try {
    telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
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
  if (vocabulary) keyboard.push([{ text: '💥 Open vocabulary', url: vocabulary.url }])
  keyboard.push([{ text: '📝 Open homework', url: homework.url }])
  grammar.forEach((item: any, index: number) => {
    const label = grammar.length === 1 ? '📐 Review grammar' : `📐 ${String(item.title || `Grammar ${index + 1}`).slice(0, 48)}`
    keyboard.push([{ text: label, url: item.url }])
  })

  try {
    const telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
      buildMaterialMessage(Boolean(vocabulary)),
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

    if (payload?.eventType === 'homework_report') {
      return handleHomeworkReport(payload, ctx, botToken)
    }
    return handleMaterialNotification(payload, req, ctx, botToken)
  }),
}
