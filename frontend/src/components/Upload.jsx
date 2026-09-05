import React, { useState, useCallback } from 'react';
import axios from 'axios';

export default function Upload({ onUploaded }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);

  const uploadFile = useCallback(
    async (file) => {
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext !== 'xlsx' && ext !== 'xls') {
        setError('Пожалуйста, загрузите файл .xlsx или .xls');
        return;
      }

      setFileName(file.name);
      setError(null);
      setIsLoading(true);

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await axios.post('/api/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        onUploaded(res.data);
      } catch (err) {
        setError(err.response?.data?.error || 'Не удалось загрузить файл');
      } finally {
        setIsLoading(false);
      }
    },
    [onUploaded]
  );

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    uploadFile(file);
  };

  const handleFileInput = (e) => {
    const file = e.target.files?.[0];
    uploadFile(file);
  };

  return (
    <div className="max-w-2xl mx-auto mt-16">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-16 text-center transition-colors ${
          isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white'
        }`}
      >
        <p className="text-lg text-gray-600 mb-2">
          Перетащите XLSX файл сюда или
        </p>
        <label className="inline-block cursor-pointer text-blue-600 font-medium hover:underline">
          выберите файл
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileInput}
          />
        </label>

        {isLoading && (
          <p className="mt-4 text-sm text-gray-500">Обработка {fileName}...</p>
        )}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
