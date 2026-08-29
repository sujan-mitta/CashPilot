import React from "react";

export const PageLoading: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] w-full text-white">
      <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin mb-4"></div>
      <p className="text-gray-400 font-medium">Loading...</p>
    </div>
  );
};
