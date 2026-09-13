import { useEffect } from 'react';
import { CONTRACTOR_LANDING_DATA } from '@/components/landing-page/landing-data-contractor';

import {
  BannerComponent,
  Footer,
  HeaderMediaComponent,
  HowItWorksCards,
  Navbar,
  SectionContent,
} from '@/components/landing-page';

export function HomePage() {
  const formDesignLandingData = CONTRACTOR_LANDING_DATA;
  useEffect(() => { document.title = 'FORM for Contractors — Win more bids'; }, []);

  return (
    <>
      <Navbar />
      <div style={{ backgroundColor: 'hsl(var(--black-50))' }}>
        <HeaderMediaComponent data={formDesignLandingData.items[0].contentSlotsCollection} isBlack />
        <BannerComponent className="mt-0" data={formDesignLandingData.items[1].contentSlotsCollection} />
        <HowItWorksCards data={formDesignLandingData.items[3].contentSlotsCollection} />
        <BannerComponent className="mt-0" data={formDesignLandingData.items[4].contentSlotsCollection} isBlack />
        <SectionContent
          className="mt-32 px-4 lg:px-0"
          contentClassName="bg-black-100"
          imgClassName="md:object-cover"
          data={formDesignLandingData.items[5].contentSlotsCollection}
        />
        <SectionContent
          className="mt-32 px-4 lg:px-0"
          contentClassName="bg-black-100"
          imgClassName="md:object-cover"
          data={formDesignLandingData.items[6].contentSlotsCollection}
        />
        <SectionContent
          className="mt-32 px-4 lg:px-0"
          imgClassName="h-[300px] md:h-[500px] md:object-cover"
          data={formDesignLandingData.items[7].contentSlotsCollection}
        />
        <SectionContent
          className="mt-32 px-4 lg:px-0"
          contentClassName="bg-black-100"
          imgClassName="md:object-cover"
          data={formDesignLandingData.items[8].contentSlotsCollection}
        />
        <SectionContent
          className="mt-32 px-4 lg:px-0"
          imgClassName="h-[300px] md:h-[500px] md:object-cover"
          data={formDesignLandingData.items[9].contentSlotsCollection}
        />
        <div className="md:mx-16">
          <BannerComponent
            className="mt-16"
            contentClassName="text-base leading-7 font-thin mt-4"
            data={formDesignLandingData.items[10].contentSlotsCollection}
            showInColumns
            isBlack
          />
        </div>
      </div>
      <Footer />
    </>
  );
}

export default HomePage;
