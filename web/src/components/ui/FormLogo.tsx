import { forwardRef } from 'react';

interface FormLogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  white?: boolean;
}

const DEFAULT_HEIGHT = 21;
const DEFAULT_WIDTH = 104;

export const FormLogo = forwardRef<SVGSVGElement, FormLogoProps>(
  ({ size = DEFAULT_WIDTH, white = false, className, ...props }, ref) => {
    const color = white ? '#FFFFFF' : 'currentColor';
    const height = (size * DEFAULT_HEIGHT) / size;

    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={height}
        fill="none"
        viewBox="0 0 104 21"
        stroke="none"
        ref={ref}
        className={className}
        {...props}
      >
        <path
          fill={color}
          d="M0 .625h13.89v2.407H2.68v6.249h10.18v2.408H2.68v8.687H0zM26.4 3.17C28.257 1.28 30.746.335 33.838.335c3.108 0 5.582.945 7.453 2.835 1.87 1.89 2.822 4.328 2.886 7.33-.064 3.002-1.015 5.44-2.886 7.33s-4.345 2.835-7.453 2.835-5.581-.945-7.452-2.834-2.823-4.329-2.886-7.33c.063-3.003 1.03-5.457 2.902-7.331m-.205 7.33c0 2.24.681 4.1 2.045 5.563s3.235 2.194 5.597 2.194q3.544 0 5.613-2.194c1.38-1.463 2.062-3.323 2.062-5.563s-.682-4.1-2.062-5.563q-2.07-2.194-5.613-2.194c-2.362 0-4.233.731-5.597 2.194s-2.045 3.308-2.045 5.563M67.674 20.376v-1.982c0-1.737-.19-2.926-.556-3.566a7 7 0 0 0-.713-1.082c-.603-.716-1.649-1.067-3.14-1.067h-6.088v7.697h-2.68V.625h8.182c2.664 0 4.677.533 6.01 1.584q1.997 1.578 1.997 4.161c0 1.158-.317 2.18-.967 3.094s-1.586 1.585-2.823 1.996v.061c2.316.58 3.473 2.728 3.473 6.416v2.439zM62.489 10.24c1.68 0 3.028-.32 4.011-.96s1.49-1.54 1.49-2.682c0-1.159-.427-2.027-1.284-2.637-.856-.61-2.315-.9-4.376-.9h-5.185v7.179zM99.814.625H104v19.75h-2.68V3.338h-.064L94.01 20.376h-2.775L83.973 3.337h-.032v17.039h-2.68V.625h4.187l7.15 16.886h.064z"
        />
      </svg>
    );
  },
);

FormLogo.displayName = 'FormLogo';
