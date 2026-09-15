export function TextWorkflow() {
  return (
    <section className="form-container my-16 grid items-center gap-10 bg-[#eeeee6] p-6 md:my-24 md:grid-cols-2 md:gap-16 md:p-14" aria-labelledby="text-workflow">
      <div>
        <h2 id="text-workflow" className="text-3xl leading-tight md:text-4xl">Design support,<br />one text away.</h2>
        <p className="mt-6 text-base leading-7 text-black-600">Text FORM directly or bring your homeowner and designer into a shared conversation. Work through ideas together, wherever the job takes you.</p>
        <p className="mt-4 text-sm leading-7 text-black-600">Estimates, changes, and follow-ups are next. Same conversation. Less admin.</p>
      </div>
      <figure className="min-w-0 rounded-2xl border border-[#d8d9cf] bg-[#fafaf7] p-5 shadow-sm md:p-8">
        <div className="mb-7 flex items-center gap-3 border-b border-[#dedfd6] pb-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#344432] text-white">F</span>
          <div><p className="text-sm font-medium">Miller kitchen</p><p className="text-xs text-black-600">You, your client &amp; FORM</p></div>
        </div>
        <div className="space-y-4 text-sm leading-6">
          <p className="ml-7 rounded-2xl rounded-br-sm bg-[#344432] p-4 text-white">We like the oak cabinets. Can we try a lighter countertop?</p>
          <p className="mr-7 rounded-2xl rounded-bl-sm bg-[#eaece4] p-4">Of course. I’ll keep the oak and show you a lighter countertop in the next design.</p>
        </div>
        <figcaption className="mt-6 text-xs leading-5 text-black-600">Example design conversation.</figcaption>
      </figure>
    </section>
  );
}
