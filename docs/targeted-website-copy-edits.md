# Targeted website copy edits

**Applied on 15 September 2026.** All eight copy-edit groups below are implemented on top of the original website at commit `ed86094`. Keep its layout, fonts, widths, form structure, images, and all seven media logos. These are substitutions inside existing elements, with no new sections.

Original paragraph excerpts below identify the replaced text; replacement paragraphs are complete.

| Priority / location | Original | Applied replacement | Why |
|---|---|---|---|
| 1. Hero heading | “Contractors: Win More Bids With Free Professional Design.” | **Win more kitchen jobs with better design.** | Leads with the contractor benefit and restores the design focus. |
| 2. Hero paragraph | “3D designs + priced materials list in days, not weeks. Earn 5% referral on every project. Design + procurement coordinated in one place. No apps, no complexity, no upfront cost.” | **Your AI kitchen design assistant, one text away. Help clients picture the result, choose the details, and move forward with your bid.** | Explains the offer in fewer words; replaces the unverified referral and timing claims. |
| 3. Existing primary landing buttons: hero, three steps, closing banner | “Get started” | **Get design support for my next bid** | Uses the selected, concrete next action. Keep the compact navigation/footer labels as they are. |
| 4. Existing social-proof sentence | “Built by the team behind FORM Kitchens, with 2,000+ projects delivered and featured in:” | **Experience from over 2,000 FORM Kitchens projects. As featured in:** | Preserves the scale and every logo, without claiming delivery outcomes or an unchanged team. |
| 5. Pricing copy in steps 2–3 and the existing pricing section | Step 2: “Get Design + Pricing” and “We design and gather quotes across our supplier network…”; step 3: “Outshine competitors with professional proposals and better pricing on materials—typically 20% below retail.”; section: “Better Prices That Win Bids” and “We compare pricing across our supplier network…” | Step 2 heading: **Get Design + Selections**. Body: **Explore kitchen designs and refine the details with your client.** Step 3 body: **Give clients a design they can picture and a clearer reason to choose you.** Pricing-section heading: **A clearer scope for your bid**. Body: **Start with an approved design and organized selections, then confirm measurements and supplier prices for your proposal.** | Replaces repeated sourcing and percentage claims with a specific benefit to the bid. |
| 6. Existing economics section | “Better Economics for Everyone”; paragraph beginning “Our trade-only model is how we deliver better pricing” and promising contractors 5% and clients 20% savings. | Heading: **More time for the job**. Body: **FORM works through design questions and client feedback, helping you keep decisions moving while you focus on the build.** | Keeps the business value without inventing earnings or savings. |
| 7. Existing “Coordinated Design & Materials” section | “Stop juggling quotes from flooring reps, cabinet dealers, window suppliers, and showrooms. FORM acts as your design and procurement team—coordinating sourcing and pricing across all materials.” | Heading: **Design support and the next steps**. Body: **Kitchen design today, with estimates, scope changes, and job follow-ups by text planned next. You lead the client relationship and the work.** | Gives the broader vision one short paragraph, with its future status clear. |
| 8. Signup introduction and submit button | “Tell us a little about yourself. We’ll connect you with your FORM design agent.” / “Meet my design agent” | **Share your details to get FORM’s number, then start your kitchen project by text.** / **Get design support for my next bid** | Describes the actual phone handoff without changing the form. |

Implementation changes only the two source files listed below, using text substitutions. No pilot branding, repeated free messaging, FAQ, added feature blocks, or redesign.

## File locations

- Edits 1–7: `web/src/components/landing-page/landing-data-contractor.ts`.
- Edit 8: `web/src/pages/contractorSignup.tsx`.
- No changes to styles, image assets, component structure, routes, validation, or backend behavior.
