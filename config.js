window.APP_CONFIG = {
  student: {
    id: "elina",
    nameRu: "Элина",
    nameEn: "Elina",
    level: "A2.2",
    textbook: "Outcomes",
    textbookEdition: "Pre-Intermediate"
  },

  // Общий проект Supabase: тот же, что используется сайтом Кристины.
  supabase: {
    url: "https://svejqcrkxkiheucglikq.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2ZWpxY3JreGtpaGV1Y2dsaWtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTE5MDUsImV4cCI6MjA5OTU4NzkwNX0.UUX5_atNjuNdexdhrGQG24UgXLibOE9VgpNcQo3t3nw",
    tables: {
      homework: "homework_progress",
      vocabulary: "vocabulary_progress",
      vocabularyTopics: "vocabulary_topic_progress",
      grammar: "grammar_progress"
    }
  },

  features: {
    homework: true,
    vocabulary: true,
    wordPronunciation: true,
    grammar: true,
    cloudSync: true,
    telegramNotifications: false
  }
};
