import type { Slots } from '@/components/landing-page/types';

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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col px-4 py-16 md:px-20 md:py-32">
      <h4 className="mb-4 text-black-700 md:text-4xl">{info.slotTitle}</h4>
      <p className="text-base font-light leading-7 text-black-600">{info.description}</p>
      <div className="mt-20 flex flex-col justify-between gap-x-4 gap-y-20 sm:flex-row">
        {cards.map((card, idx) => {
          const content = renderDocument(card.markdown?.json);

          return (
            <div key={card.photosCollection.items[0]?.title || idx} className="flex-1">
              <div className="mb-6">
                <img
                  src={card.photosCollection.items[0].url}
                  alt={card.photosCollection.items[0].title}
                  className="max-h-[400px] md:max-h-132 w-full object-contain"
                />
              </div>
              <div className="max-w-80 self-center sm:self-auto">
                <h5 className="mb-4 flex items-center gap-2 border-b border-black-200 pb-2 md:text-3xl">
                  <span className="text-base font-light text-black-500">{idx + 1}</span>
                  {card.slotTitle}
                </h5>
                {content}
              </div>
            </div>
          );
        })}
      </div>
      <a
        className="mt-20 self-center inline-flex items-center justify-center h-9 w-full sm:w-max px-4 py-2 rounded-xs text-sm font-light capitalize bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:bg-primary-hover active:bg-primary/90 transition-colors md:min-w-60"
        href={info.actionUrl ?? ''}
      >
        {info.actionText}
      </a>
    </div>
  );
};
