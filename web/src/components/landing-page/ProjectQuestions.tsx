const questions = [
  {
    question: 'What do I get when I join?',
    answer: 'You get FORM’s number and a contact card. Text kitchen photos and work through ideas with your AI design agent. Kitchen design is available now, with estimating and job admin rolling out during the free pilot.',
  },
  {
    question: 'How does this help my next bid?',
    answer: 'Help your client see the kitchen they want to build, then use the agreed design to make your proposal clearer. As the pilot grows, FORM will also help draft estimates from your scope and rates, track changes, and organize follow-ups.',
  },
  {
    question: 'Is FORM free?',
    answer: 'Yes. The contractor pilot is free to join and use, with no credit card required. Start with kitchen design support and help shape the estimating and job admin tools as they roll out.',
  },
  {
    question: 'Do I need another app?',
    answer: 'No. Text FORM from your phone. You can also use an iMessage group for shared design feedback. We’re building estimating and job admin around text, with simple links for documents that need a closer look.',
  },
  {
    question: 'Can my client or architect join in?',
    answer: 'Yes, a shared iMessage group can include your homeowner, architect, or designer for design feedback. We’re building support for several conversations on one job: private help for you, shared decisions with the project team, and control over who sees each detail.',
  },
  {
    question: 'Who leads the project?',
    answer: 'You do. FORM helps your homeowner explore designs and keeps track of their choices. You stay in the conversation and lead the measurements, proposal, material checks, and work on site.',
  },
  {
    question: 'Does approving a design place an order?',
    answer: 'Approval saves the design and the selected details. Before ordering, you confirm measurements, exact products, supplier prices, and the scope of work with your client.',
  },
];

export function ProjectQuestions() {
  return (
    <section className="form-container grid gap-10 py-16 md:grid-cols-[.8fr_1.2fr] md:gap-20 md:py-24" aria-labelledby="project-questions">
      <h2 id="project-questions" className="text-3xl leading-tight md:text-4xl">A few things to know<br />before your first project.</h2>
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
