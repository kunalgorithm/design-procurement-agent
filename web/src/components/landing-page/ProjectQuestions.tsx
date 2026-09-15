const questions = [
  {
    question: 'How do I start?',
    answer: 'Sign up to get FORM’s number, then text a kitchen photo and a quick introduction. No app to download.',
  },
  {
    question: 'Can my client or architect join?',
    answer: 'Yes. Start an iMessage group with FORM and your homeowner, architect, or designer before sharing the project. You can also work with FORM directly. Connecting several conversations to one shared job is next.',
  },
  {
    question: 'Who leads the project?',
    answer: 'You do. FORM helps with design ideas and feedback. You approve the direction with your client and confirm measurements, products, and pricing before ordering.',
  },
];

export function ProjectQuestions() {
  return (
    <section className="form-container grid gap-10 py-12 md:grid-cols-[.8fr_1.2fr] md:gap-20 md:py-16" aria-labelledby="project-questions">
      <h2 id="project-questions" className="text-3xl leading-tight md:text-4xl">Before your<br />first project.</h2>
      <div>
        {questions.map(({ question, answer }) => (
          <details key={question} className="border-b border-black-300 py-5 first:border-t">
            <summary className="cursor-pointer text-base font-semibold">{question}</summary>
            <p className="mt-4 max-w-prose text-sm leading-7 text-black-600">{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
