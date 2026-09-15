import { ArrowRight, ClipboardList, FileCheck2, MessageCircle } from 'lucide-react';
import { Link } from 'react-router';

const tools = [
  {
    icon: ClipboardList,
    title: 'Get the next bid out faster',
    copy: 'Text the job details. Turn your scope and rates into an itemized estimate you can check, adjust, and send to your client.',
    prompt: '“Draft an estimate for the Miller kitchen using my cabinet install rate.”',
  },
  {
    icon: FileCheck2,
    title: 'Keep extra work from eating your profit',
    copy: 'Turn a client’s new request into a clear change order. Agree on the extra work and price before you start.',
    prompt: '“Add the island outlets as a change order for me to review.”',
  },
  {
    icon: MessageCircle,
    title: 'Spend your evenings off the paperwork',
    copy: 'Keep proposals, invoice records, and follow-ups moving from your phone. Ask what needs attention and pick up where you left off.',
    prompt: '“What’s waiting on a client, and which invoices are due?”',
  },
];

export function ContractorTools() {
  return (
    <section className="form-container py-16 md:py-24" aria-labelledby="contractor-tools">
      <div className="max-w-3xl">
        <p className="mb-5 text-xs tracking-[.18em] text-black-600">THE FREE CONTRACTOR PILOT</p>
        <h2 id="contractor-tools" className="text-3xl leading-tight md:text-5xl">More jobs won.<br />Less work after work.</h2>
        <p className="mt-6 max-w-2xl text-base leading-7 text-black-600">Design helps you win the job. Estimates and job admin help you keep it profitable. We’re bringing them into the same text conversation.</p>
      </div>
      <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-12">
        {tools.map(({ icon: Icon, title, copy, prompt }) => (
          <article key={title} className="min-w-0 border-t border-black-300 pt-6">
            <Icon size={26} strokeWidth={1.3} className="mb-7 text-[#344432]" aria-hidden="true" />
            <h3 className="text-xl leading-snug">{title}</h3>
            <p className="mt-4 text-sm leading-7 text-black-600">{copy}</p>
            <p className="mt-6 rounded-lg bg-[#eeeee6] p-4 text-sm leading-6 text-[#46533e]">{prompt}</p>
          </article>
        ))}
      </div>
      <Link className="form-button mt-10" to="/signup">Get design support for my next bid <ArrowRight size={18} aria-hidden="true" /></Link>
    </section>
  );
}

export function TextWorkflow() {
  return (
    <section className="form-container my-16 grid items-center gap-10 bg-[#eeeee6] p-6 md:my-24 md:grid-cols-2 md:gap-16 md:p-14" aria-labelledby="text-workflow">
      <div>
        <p className="mb-5 text-xs tracking-[.18em] text-black-600">BUILT AROUND THE WAY YOU WORK</p>
        <h2 id="text-workflow" className="text-3xl leading-tight md:text-4xl">Your next move.<br />One text away.</h2>
        <p className="mt-6 text-base leading-7 text-black-600">Send the details between site visits. Get a draft back. Review it, make a change, and decide what your client sees.</p>
        <p className="mt-4 text-base leading-7 text-black-600">A private text for your business. Shared project conversations with your homeowner, architect, or designer. We’re building one connected job, with the right details shared in each conversation.</p>
        <p className="mt-4 text-sm leading-7 text-black-600">No new app to learn. Just text, with simple links when there’s something to review.</p>
      </div>
      <figure className="min-w-0 rounded-2xl border border-[#d8d9cf] bg-[#fafaf7] p-5 shadow-sm md:p-8">
        <div className="mb-7 flex items-center gap-3 border-b border-[#dedfd6] pb-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#344432] text-white">F</span>
          <div><p className="text-sm font-medium">FORM</p><p className="text-xs text-black-600">Your contractor assistant</p></div>
        </div>
        <div className="space-y-4 text-sm leading-6">
          <p className="ml-7 rounded-2xl rounded-br-sm bg-[#344432] p-4 text-white">Miller kitchen: add $650 for two island outlets. Draft the change order.</p>
          <p className="mr-7 rounded-2xl rounded-bl-sm bg-[#eaece4] p-4">Draft ready: two island outlets, $650 additional. Review the scope before I send it to the client.</p>
          <p className="ml-7 rounded-2xl rounded-br-sm bg-[#344432] p-4 text-white">Include patching. Send me the updated draft.</p>
        </div>
        <figcaption className="mt-6 text-xs leading-5 text-black-600">Example of the planned pilot workflow. You review the scope and price before a client receives it.</figcaption>
      </figure>
    </section>
  );
}
