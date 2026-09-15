import type { Slots } from '@/components/landing-page/types';
import { ArrowRight, Camera, Image, ClipboardCheck } from 'lucide-react';

interface HowItWorksCardsProps {
  data: Slots;
}

const renderDocument = (doc: any) => {
  if (!doc) return null;
  return doc.content.map((para: any, idx: number) => (
    <p key={idx} className="text-base font-light leading-7 text-black-600">
      {para.content.map((text: any) => text.value).join('')}
    </p>
  ));
};

export const HowItWorksCards = ({ data }: HowItWorksCardsProps) => {
  const info = data.items[0];
  const cards = data.items.slice(1);
  const icons = [Camera, Image, ClipboardCheck];

  return (
    <section className="form-container flex flex-col py-16 md:py-24" aria-labelledby="how-it-works">
      <h2 id="how-it-works" className="mb-4 text-3xl text-black-700 md:text-4xl">{info.slotTitle}</h2>
      <p className="text-base font-light leading-7 text-black-600">{info.description}</p>
      <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-12">
        {cards.map((card, idx) => {
          const content = renderDocument(card.markdown?.json);
          const Icon = icons[idx] ?? ClipboardCheck;

          return (
            <div key={card.slotTitle} className="min-w-0">
              <div className="mb-7 flex items-center justify-between border-b border-black-300 pb-5">
                <span className="text-sm text-black-500">0{idx + 1}</span>
                <Icon size={30} strokeWidth={1.25} aria-hidden="true" />
              </div>
              <div>
                <h3 className="mb-4 text-2xl leading-tight">
                  {card.slotTitle}
                </h3>
                {content}
              </div>
            </div>
          );
        })}
      </div>
      <a
        className="form-button mt-12 self-start"
        href={info.actionUrl ?? ''}
      >
        {info.actionText}
        <ArrowRight size={18} aria-hidden="true" />
      </a>
    </section>
  );
};
