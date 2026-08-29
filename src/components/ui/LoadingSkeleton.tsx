import React from "react";

interface LoadingSkeletonProps {
  variant?: "card" | "text" | "chart";
  className?: string;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ variant = "card", className = "" }) => {
  const baseClasses = "animate-pulse bg-white/10 rounded-md";
  
  let variantClasses = "";
  switch (variant) {
    case "text":
      variantClasses = "h-4 w-3/4";
      break;
    case "chart":
      variantClasses = "h-64 w-full";
      break;
    case "card":
    default:
      variantClasses = "h-32 w-full";
      break;
  }

  return (
    <div className={`${baseClasses} ${variantClasses} ${className}`} />
  );
};
