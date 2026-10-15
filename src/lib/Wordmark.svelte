<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 56 11.2"
  width="168"
  height="33.6"
  fill="currentColor"
  aria-hidden="true"
  focusable="false"
  class="wordmark"
>
  <svg width="8" height="11.2" viewBox="0 0 8 11.2" overflow="hidden">
    <g class="roll-column">
      <path d="M1.0 8.5V7.5H0.0V4.5H1.0V3.5H6.0V4.5H7.0V6.5H2.0V7.5H6.0V8.5ZM2.0 5.5H5.0V4.5H2.0Z" />
      <path d="M1.0 8.5V7.5H0.0V4.5H1.0V3.5H6.0V4.5H7.0V7.5H6.0V8.5ZM2.0 7.5H5.0V4.5H2.0Z" transform="translate(0 11.2)" />
    </g>
  </svg>
  <svg x="16" width="8" height="11.2" viewBox="0 0 8 11.2" overflow="hidden">
    <g class="roll-column alternate">
      <path d="M1.0 8.5V7.5H0.0V3.5H2.0V7.5H5.0V3.5H7.0V8.5Z" />
      <path d="M1.0 8.5V7.5H0.0V6.5H1.0V5.5H5.0V4.5H1.0V3.5H6.0V4.5H7.0V8.5ZM2.0 7.5H5.0V6.5H2.0Z" transform="translate(0 11.2)" />
    </g>
  </svg>
  <path d="M8.0 8.5V3.5H14.0V4.5H15.0V8.5H13.0V4.5H12.0V8.5H10.0V4.5H9.0V8.5ZM24.0 8.5V1.5H26.0V5.5H28.0V4.5H29.0V3.5H31.0V4.5H30.0V5.5H29.0V6.5H30.0V7.5H31.0V8.5H29.0V7.5H28.0V6.5H26.0V8.5ZM33.0 8.5V7.5H32.0V6.5H33.0V5.5H37.0V4.5H33.0V3.5H38.0V4.5H39.0V8.5ZM34.0 7.5H37.0V6.5H34.0ZM40.0 8.5V7.5H45.0V6.5H41.0V5.5H40.0V4.5H41.0V3.5H46.0V4.5H42.0V5.5H46.0V6.5H47.0V7.5H46.0V8.5ZM49.0 8.5V7.5H48.0V4.5H49.0V3.5H54.0V4.5H55.0V6.5H50.0V7.5H54.0V8.5ZM50.0 5.5H53.0V4.5H50.0Z" />
</svg>

<style>
  .wordmark {
    display: block;
    overflow: visible;
    filter: drop-shadow(4px 4px 0 var(--color-zinc-300));
  }

  .roll-column {
    /* 10 seconds on emukase, then a 2.5-second staggered roll and return. */
    animation: roll 12.5s infinite;
  }

  .alternate {
    animation-delay: 0.15s;
  }

  @keyframes roll {
    0%,
    80% {
      transform: translateY(0);
    }
    83.2%,
    92.8% {
      transform: translateY(-11.2px);
    }
    96%,
    100% {
      transform: translateY(0);
    }
  }

  @media (prefers-color-scheme: dark) {
    .wordmark {
      filter: drop-shadow(4px 4px 0 var(--color-zinc-700));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .roll-column {
      animation: none;
    }
  }
</style>
